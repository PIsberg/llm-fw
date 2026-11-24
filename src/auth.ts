import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP, isIPv4, isIPv6 } from 'node:net';

/**
 * Shared credential handling for every listener that can be exposed off-host:
 * the dashboard (`Authorization`), the forward proxy (`Proxy-Authorization`),
 * and the gateway. Kept in one module so the three surfaces cannot drift into
 * three subtly different comparison or parsing rules.
 */

/** True for the loopback addresses, including the IPv4-mapped IPv6 form. */
export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  // Any spelling of the loopback addresses (#920): the IPv4-mapped prefix in
  // either case, brackets, and IPv6 written out in full or compressed
  // differently. ::FFFF:127.0.0.1 and 0:0:0:0:0:0:0:1 used to read as remote.
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  a = a.replace(/^::ffff:(?=\d)/, '');
  if (isIPv4(a)) return a.startsWith('127.');
  if (!isIPv6(a)) return false;
  const [head = '', tail] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  // An IPv4-mapped address written in hex (::ffff:7f00:1) is loopback too.
  if (groups.length === 8 && groups.slice(0, 5).every(g => /^0+$/.test(g)) && /^0*ffff$/.test(groups[5] ?? '')) {
    return (parseInt(groups[6] ?? '0', 16) >> 8) === 127;
  }
  return groups.length === 8 && groups.slice(0, 7).every(g => /^0+$/.test(g)) && parseInt(groups[7] ?? '', 16) === 1;
}

/**
 * True when an HTTP `Host` header names this machine's loopback: `localhost`,
 * a `*.localhost` name, `127.0.0.0/8` or `[::1]`, with or without a port.
 *
 * A web page that rebinds its own domain to 127.0.0.1 reaches a loopback
 * listener FROM loopback, so the source address alone cannot tell the local
 * operator from any website they visit. The page cannot choose `Host`,
 * though: the browser sends the page's own domain (GHSA-c725-vwcm-h8rr). An
 * absent `Host` counts as local, because browsers always send one.
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return true;
  let name = host.trim().toLowerCase();
  if (name.startsWith('[')) name = name.slice(1, name.indexOf(']'));
  else if (name.split(':').length === 2) name = name.slice(0, name.indexOf(':'));
  // An IP literal, checked as one: isLoopbackAddr's "127." prefix test would
  // also accept a name like 127.x.attacker.example, which the attacker controls.
  return name === 'localhost' || name.endsWith('.localhost') || (isIP(name) !== 0 && isLoopbackAddr(name));
}

/**
 * True when a bind address only ever accepts connections from this machine.
 * An unset bindHost means the caller has not overridden the local-only default.
 */
export function isLocalBind(bindHost: string | undefined): boolean {
  // 'localhost' too (#920): it binds loopback, and read as remote it turned
  // auth on for a listener nothing off this machine can reach.
  return bindHost === undefined || bindHost.trim().toLowerCase() === 'localhost' || isLoopbackAddr(bindHost);
}

/**
 * Constant-time token comparison that tolerates differing lengths.
 *
 * Both sides are hashed to a fixed 32 bytes before comparison. Comparing the
 * raw buffers would need a length check first — `timingSafeEqual` throws on a
 * length mismatch — and that check returns before any crypto runs, so the time
 * taken would depend on whether the presented token happened to be the right
 * length. Hashing makes every comparison cost the same regardless of input
 * length, which matters where several candidate tokens are checked in a loop
 * (see TenantRegistry.resolve).
 */
export function tokenMatches(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Extract the credential from a `Bearer <token>` or `Basic <base64>` header
 * value. For Basic the token is the password half: proxy clients conventionally
 * carry credentials as `http://user:token@host:port`, and the username is not
 * meaningful to us.
 */
export function credentialFromAuthHeader(raw: string | undefined): string {
  const auth = raw ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      return decoded.slice(decoded.indexOf(':') + 1);
    } catch { /* malformed base64 — treated as no credential */ }
  }
  return '';
}

/** The credential presented on a CONNECT (or plain proxied request). */
export function presentedProxyToken(headers: IncomingHttpHeaders): string {
  return credentialFromAuthHeader(headers['proxy-authorization']);
}

/** A fresh 48-hex-character shared secret. */
export function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export interface AuthPolicy {
  /** Whether a credential is demanded at all. */
  required: boolean;
  /**
   * The expected credential. When auth is not required this is the configured
   * token, if any, so a caller that does not qualify for loopback trust (a
   * reverse proxy on this host) can still present one.
   */
  token: string;
  /** True when the token was generated rather than configured — print it once. */
  generated: boolean;
  /**
   * Whether loopback clients skip the check. True only when the requirement was
   * INFERRED from the bind: an operator who explicitly sets `requireAuth: true`
   * means every client, including one on this machine.
   */
  exemptLoopback: boolean;
  /** `requireAuth: false` set explicitly: every caller is admitted. */
  open: boolean;
}

/**
 * Decide the listener's authentication policy.
 *
 * - `requireAuth: true`  — always on, no loopback exemption.
 * - `requireAuth: false` — always off (the escape hatch for a trusted network
 *   segment where the operator has other controls).
 * - unset — on whenever the listener is bound off-host, with loopback exempt so
 *   a local operator never needs a token. This is the important default: a
 *   listener that becomes remotely reachable must not become anonymously
 *   usable at the same time.
 */
export function resolveAuthPolicy(opts: {
  requireAuth?: boolean | undefined;
  authToken?: string | undefined;
  bindHost?: string | undefined;
}): AuthPolicy {
  const inferred = !isLocalBind(opts.bindHost);
  const required = opts.requireAuth ?? inferred;
  const configured = opts.authToken ?? '';
  if (!required) return { required: false, token: configured, generated: false, exemptLoopback: true, open: opts.requireAuth === false };
  return {
    required: true,
    token: configured || generateToken(),
    generated: configured === '',
    exemptLoopback: opts.requireAuth === undefined,
    open: false,
  };
}

/**
 * Apply a resolved policy to one client. `hostHeader` is the HTTP `Host` of a
 * request to an HTTP listener; loopback trust needs it to name loopback (see
 * isLoopbackHostHeader). The proxy's CONNECT passes none: its `Host` names the
 * tunnel's target, and a browser cannot send CONNECT.
 */
export function authorizeClient(
  policy: AuthPolicy,
  remoteAddress: string | undefined,
  presented: string,
  hostHeader?: string,
): boolean {
  if (policy.open) return true;
  if (policy.exemptLoopback && isLoopbackHostHeader(hostHeader) && (!policy.required || isLoopbackAddr(remoteAddress))) return true;
  return policy.token !== '' && tokenMatches(presented, policy.token);
}
