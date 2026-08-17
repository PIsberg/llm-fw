import { networkInterfaces } from 'node:os';

/**
 * Returned when no non-internal IPv4 address can be found. It is a placeholder
 * for human-readable output, never a routable address, so anything building a
 * URL has to substitute something reachable instead.
 */
export const UNKNOWN_LAN_IP = '<this-server-ip>';

/** Best-effort primary non-internal IPv4 address, for printing client setup hints. */
export function lanIPv4(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return UNKNOWN_LAN_IP;
}

/** Wildcard binds are not addresses a client can connect back to. */
export function isWildcardBind(host: string | undefined): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

/**
 * Wrap a bare IPv6 literal in brackets so it is usable in a URL authority.
 * Already-bracketed values and hostnames/IPv4 pass through untouched.
 */
export function urlHost(host: string): string {
  if (host.startsWith('[')) return host;
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * The address a *client* should use to reach a listener bound to `bindHost`.
 * A wildcard bind resolves to this host's LAN address, falling back to loopback
 * when there is none, because a URL containing `0.0.0.0` is not fetchable.
 */
export function reachableHost(bindHost: string | undefined): string {
  if (!bindHost) return '127.0.0.1';
  if (!isWildcardBind(bindHost)) return bindHost;
  const ip = lanIPv4();
  return ip === UNKNOWN_LAN_IP ? '127.0.0.1' : ip;
}
