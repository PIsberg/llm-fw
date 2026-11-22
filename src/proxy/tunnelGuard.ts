import dns from 'node:dns';
import net from 'node:net';

/**
 * Destinations a remote proxy client must not tunnel to (GHSA-q53q-qg98-p9jf).
 *
 * A CONNECT tunnel is opened by the llm-fw process, so it arrives at its
 * target from this host. Pointed at the host's own loopback, the tunnel
 * reaches the dashboard (which exempts loopback callers from its token), a
 * loopback-bound gateway and the provider keys it holds, and any other local
 * service that trusts 127.0.0.1. Link-local reaches the cloud metadata
 * endpoint (169.254.169.254, and fd00:ec2::254 on AWS IPv6) and with it the
 * instance's credentials. The unspecified address connects to loopback on
 * Linux. Private (RFC 1918) ranges are deliberately NOT refused: a proxy that
 * clients use for all their HTTPS traffic has to reach internal hosts.
 *
 * A loopback client is not restricted: it can reach those services directly.
 */
export function isPrivilegedTunnelAddress(address: string): boolean {
  const a = address.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (net.isIPv4(a)) return isPrivilegedIPv4(a.split('.').map(Number));
  const h = ipv6Hextets(a);
  if (!h) return false;
  // Compared as numbers, never as strings (#849): net.isIP accepts every
  // spelling (0:0:0:0:0:0:0:1, ::0, ::ffff:7f00:1, fd00:0ec2::254), so a
  // literal skips the lookup guard and only this check stands in its way.
  const zero = (from: number, to: number): boolean => h.slice(from, to).every(x => x === 0);
  if (zero(0, 7) && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if (((h[0] ?? 0) & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (h[0] === 0xfd00 && h[1] === 0x0ec2 && zero(2, 7) && h[7] === 0x254) return true; // AWS IPv6 IMDS
  // An IPv4 address carried inside an IPv6 one reaches that IPv4 address:
  // mapped ::ffff:0:0/96, compatible ::/96, translated ::ffff:0:0:0/96 and
  // the NAT64 well-known prefix 64:ff9b::/96.
  const carriesIPv4 = (zero(0, 5) && (h[5] === 0xffff || h[5] === 0))
    || (zero(0, 4) && h[4] === 0xffff && h[5] === 0)
    || (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6));
  if (carriesIPv4) {
    const hi = h[6] ?? 0;
    const lo = h[7] ?? 0;
    return isPrivilegedIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  return false;
}

/** 127.0.0.0/8, 0.0.0.0/8 and 169.254.0.0/16. */
function isPrivilegedIPv4(octets: number[]): boolean {
  const [first, second] = octets;
  return first === 127 || first === 0 || (first === 169 && second === 254);
}

/**
 * An IPv6 literal as eight 16-bit numbers, or null when it is not one. A zone
 * (%eth0) is dropped, and a trailing dotted IPv4 becomes the last two.
 */
function ipv6Hextets(literal: string): number[] | null {
  const a = literal.split('%', 1)[0] ?? '';
  if (!net.isIPv6(a)) return null;
  let s = a;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (net.isIPv4(tail)) {
    const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = tail.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((o0 << 8) | o1).toString(16)}:${((o2 << 8) | o3).toString(16)}`;
  }
  const halves = s.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const gap = halves.length > 1 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: gap }, () => '0'), ...right].map(g => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every(g => g >= 0 && g <= 0xffff) ? groups : null;
}

/** The tunnel was refused because its destination resolved to a privileged address. */
export class TunnelRefused extends Error {
  constructor(readonly address: string) {
    super(`tunnel to ${address} refused: loopback, unspecified and link-local destinations are not reachable through the proxy`);
    this.name = 'TunnelRefused';
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A `net.connect` lookup that refuses privileged addresses. It checks what the
 * name actually resolved to, so `localhost`, a DNS name pointing at 127.0.0.1
 * and getaddrinfo's numeric spellings ("2130706433") are refused like the
 * literal. With `all: true` (Node's happy-eyeballs path) one privileged
 * address refuses the whole set, so the connection cannot race onto it.
 * IP literals never reach a lookup; callers check those with
 * isPrivilegedTunnelAddress first.
 */
export function privilegedAddressGuard(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) { callback(err, ''); return; }
    const bad = addresses.find(a => isPrivilegedTunnelAddress(a.address));
    if (bad) { callback(new TunnelRefused(bad.address), ''); return; }
    if (options.all) { callback(null, addresses); return; }
    const first = addresses[0];
    if (!first) { callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), ''); return; }
    callback(null, first.address, first.family);
  });
}
