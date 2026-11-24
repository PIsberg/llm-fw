import { Resolver } from 'node:dns/promises';
import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProxyConfig } from '../types.js';

/** The most hosts whose addresses are kept (#866: the cache had no bound). */
export const MAX_RESOLVER_CACHE = 1024;
const TTL_MS = 60_000;

export interface ResolverDeps {
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
  lookup: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

// Addresses a sinkhole's hosts file points provider hosts at, and nothing an
// upstream should resolve to: connecting there would reach this proxy.
function isLoopbackOrUnspecified(ip: string): boolean {
  return ip.startsWith('127.') || ip === '::1' || ip === '0.0.0.0' || ip === '::' || ip.startsWith('::ffff:127.');
}

/**
 * Where an intercepted host's upstream connection goes (#866).
 *
 * Public resolvers first (`proxy.dnsServers`, 1.1.1.1 and 8.8.8.8 by
 * default), because in sinkhole mode the hosts file points every provider
 * host at 127.0.0.1 and the system resolver would hand that back. Then AAAA,
 * for an IPv6-only host. Then the system resolver, for a name only a private
 * zone knows (a self-hosted endpoint behind corporate DNS) or a network that
 * blocks outbound DNS, with loopback answers refused for the reason above.
 * An IP literal needs no lookup. Every address is kept: `markFailed` drops
 * one that would not connect, so the next request goes to the next address,
 * and the host is looked up again once all have failed.
 */
export class UpstreamResolver {
  private readonly deps: ResolverDeps;
  private cache = new Map<string, { ips: string[]; expiresAt: number }>();

  constructor(config: ProxyConfig, deps?: ResolverDeps) {
    if (deps) {
      this.deps = deps;
      return;
    }
    const resolver = new Resolver();
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- public DNS resolvers to bypass local /etc/hosts sinkhole
    resolver.setServers(config.dnsServers ?? ['1.1.1.1', '8.8.8.8']);
    this.deps = {
      resolve4: h => resolver.resolve4(h),
      resolve6: h => resolver.resolve6(h),
      lookup: h => systemLookup(h, { all: true }),
    };
  }

  /** Hosts whose addresses are cached. */
  get cacheSize(): number { return this.cache.size; }

  async resolve(hostname: string): Promise<string> {
    const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (isIP(bare) !== 0) return bare;
    const cached = this.cache.get(hostname);
    if (cached && performance.now() < cached.expiresAt && cached.ips[0]) return cached.ips[0];
    const ips = await this.lookupAll(hostname);
    this.cache.delete(hostname);
    if (this.cache.size >= MAX_RESOLVER_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(hostname, { ips, expiresAt: performance.now() + TTL_MS });
    return ips[0]!;
  }

  /** `ip` did not connect: the next request for `hostname` goes elsewhere. */
  markFailed(hostname: string, ip: string): void {
    const entry = this.cache.get(hostname);
    if (!entry) return;
    entry.ips = entry.ips.filter(a => a !== ip);
    if (entry.ips.length === 0) this.cache.delete(hostname);
  }

  private async lookupAll(hostname: string): Promise<string[]> {
    for (const query of [this.deps.resolve4, this.deps.resolve6]) {
      try {
        const ips = await query(hostname);
        if (ips.length) return ips;
      } catch { /* no record, or the resolver cannot be reached: try the next source */ }
    }
    let system: { address: string }[] = [];
    try { system = await this.deps.lookup(hostname); } catch { /* reported below */ }
    const ips = system.map(a => a.address).filter(ip => !isLoopbackOrUnspecified(ip));
    if (ips.length) return ips;
    throw new Error(`No usable address for ${hostname}: public DNS has no A or AAAA record, and the system resolver gave ${system.length ? 'only loopback' : 'none'}`);
  }
}
