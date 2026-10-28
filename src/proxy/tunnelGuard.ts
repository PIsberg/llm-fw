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
  const a = address.replace(/^\[(.*)\]$/, '$1').toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (net.isIPv4(a)) {
    const first = Number(a.split('.')[0]);
    const second = Number(a.split('.')[1]);
    return first === 127 || first === 0 || (first === 169 && second === 254);
  }
  if (net.isIPv6(a)) {
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- AWS EC2 IPv6 IMDS endpoint blocked from CONNECT tunnels
    if (a === '::1' || a === '::' || a === 'fd00:ec2::254') return true;
    // fe80::/10: the first hextet is fe80 to febf.
    return /^fe[89ab][0-9a-f]:/.test(a);
  }
  return false;
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
