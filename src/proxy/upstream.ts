import { Resolver } from 'node:dns/promises';
import { ProxyConfig } from '../types.js';

export class UpstreamResolver {
  private resolver: Resolver;
  private cache = new Map<string, { ip: string; expiresAt: number }>();

  constructor(config: ProxyConfig) {
    this.resolver = new Resolver();
    this.resolver.setServers(config.dnsServers ?? ['1.1.1.1', '8.8.8.8']);
  }

  async resolve(hostname: string): Promise<string> {
    const cached = this.cache.get(hostname);
    if (cached && performance.now() < cached.expiresAt) return cached.ip;
    const addresses = await this.resolver.resolve4(hostname);
    if (!addresses.length) throw new Error('No A records for ' + hostname);
    const ip = addresses[0];
    this.cache.set(hostname, { ip, expiresAt: performance.now() + 60_000 });
    return ip;
  }
}
