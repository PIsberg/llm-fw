import { tokenMatches } from '../auth.js';
import type { TenantConfig } from '../types.js';

/**
 * Per-tenant identity, policy and quota for the gateway.
 *
 * One shared token tells you a caller is authorised and nothing else. A company
 * running this in front of several teams needs three things a single token
 * cannot give them: to know WHICH team a block belongs to when someone asks why
 * their agent broke, to stop one team's runaway loop spending everyone's budget,
 * and to onboard a new team in observation while everyone else stays enforced.
 *
 * Deliberately in-process and per-instance, matching the DoS quota and taint
 * tracker: with several replicas each sees only the share of traffic that lands
 * on it. That is stated in the Helm chart's values rather than papered over —
 * a shared quota store is a different piece of work, and pretending otherwise
 * would make the limit look stronger than it is.
 */
export interface Tenant {
  /** Stable identifier used for attribution on events and metrics. */
  id: string;
  name: string;
  /** Provider slugs this tenant may reach; empty means all. */
  providers: string[];
  /** Requests per minute; 0 or absent means unlimited. */
  quotaPerMinute: number;
  /**
   * Per-tenant enforcement. 'observe' lets one team run in observation while
   * the rest of the deployment enforces — the practical way to onboard a team
   * without either exposing them to day-one false positives or turning the
   * firewall off for everybody.
   */
  enforcement: 'enforce' | 'observe';
}

export interface QuotaDecision {
  allowed: boolean;
  /** Requests already counted in the current window, including this one. */
  used: number;
  limit: number;
  /** Seconds until the window resets, for Retry-After. */
  retryAfterSeconds: number;
}

const WINDOW_MS = 60_000;

export class TenantRegistry {
  private readonly tenants: { tenant: Tenant; token: string }[] = [];
  /** id → sliding-window request timestamps. */
  private readonly hits = new Map<string, number[]>();

  constructor(config: Record<string, TenantConfig> | undefined) {
    for (const [id, entry] of Object.entries(config ?? {})) {
      if (!entry.token) continue; // a tenant without a credential can never match
      this.tenants.push({
        token: entry.token,
        tenant: {
          id,
          name: entry.name ?? id,
          providers: entry.providers ?? [],
          quotaPerMinute: entry.quotaPerMinute ?? 0,
          enforcement: entry.enforcement ?? 'enforce',
        },
      });
    }
  }

  /** True when the operator configured any tenants at all. */
  get configured(): boolean { return this.tenants.length > 0; }

  get ids(): string[] { return this.tenants.map(t => t.tenant.id).sort(); }

  /**
   * Resolve a presented credential to a tenant, or null.
   *
   * Constant-time comparison per candidate, and every candidate is checked
   * rather than short-circuiting on the first match, so response time does not
   * leak which tenant a token belongs to.
   */
  resolve(presented: string): Tenant | null {
    if (!presented) return null;
    let found: Tenant | null = null;
    for (const { token, tenant } of this.tenants) {
      if (tokenMatches(presented, token)) found = tenant;
    }
    return found;
  }

  /** Whether a tenant may use a provider slug. */
  allowsProvider(tenant: Tenant, slug: string): boolean {
    return tenant.providers.length === 0 || tenant.providers.includes(slug);
  }

  /**
   * Count one request against the tenant's quota.
   *
   * A sliding window rather than a fixed one: a fixed window lets a caller
   * spend two full quotas back to back across the boundary, which is exactly
   * the burst a quota exists to prevent.
   */
  charge(tenant: Tenant, now: number): QuotaDecision {
    const limit = tenant.quotaPerMinute;
    if (!limit) return { allowed: true, used: 0, limit: 0, retryAfterSeconds: 0 };

    const cutoff = now - WINDOW_MS;
    const window = (this.hits.get(tenant.id) ?? []).filter(t => t > cutoff);

    if (window.length >= limit) {
      const oldest = window[0] ?? now;
      this.hits.set(tenant.id, window);
      return {
        allowed: false,
        used: window.length,
        limit,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
      };
    }

    window.push(now);
    this.hits.set(tenant.id, window);
    return { allowed: true, used: window.length, limit, retryAfterSeconds: 0 };
  }
}
