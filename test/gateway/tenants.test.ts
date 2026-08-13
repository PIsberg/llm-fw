import { describe, it, expect } from 'vitest'
import { TenantRegistry } from '../../src/gateway/tenants.js'

/**
 * Tenant resolution is an authorisation boundary: the token decides whose
 * quota is spent, which providers are reachable, and whose traffic a block is
 * attributed to. These pin the properties that make it one.
 */

const config = {
  platform: { token: 'tok-platform', name: 'Platform team', quotaPerMinute: 3 },
  research: { token: 'tok-research', providers: ['anthropic'], enforcement: 'observe' as const },
  unlimited: { token: 'tok-unlimited' },
  broken: { token: '', name: 'no credential' },
}

describe('TenantRegistry — resolution', () => {
  const registry = new TenantRegistry(config)

  it('resolves a token to its tenant', () => {
    expect(registry.resolve('tok-platform')?.id).toBe('platform')
    expect(registry.resolve('tok-research')?.name).toBe('research')
  })

  it('refuses an unknown or empty credential', () => {
    expect(registry.resolve('tok-nope')).toBeNull()
    expect(registry.resolve('')).toBeNull()
  })

  it('ignores a tenant configured without a credential', () => {
    // Otherwise an empty token could match an empty presented credential and
    // silently admit anonymous callers as that tenant.
    expect(registry.ids).not.toContain('broken')
    expect(registry.resolve('')).toBeNull()
  })

  it('does not match on a prefix of a valid token', () => {
    expect(registry.resolve('tok-platfor')).toBeNull()
    expect(registry.resolve('tok-platform-extra')).toBeNull()
  })

  it('reports whether any tenants are configured', () => {
    expect(registry.configured).toBe(true)
    expect(new TenantRegistry(undefined).configured).toBe(false)
    expect(new TenantRegistry(undefined).resolve('anything')).toBeNull()
  })
})

describe('TenantRegistry — provider policy', () => {
  const registry = new TenantRegistry(config)

  it('restricts a tenant to its allowlist', () => {
    const research = registry.resolve('tok-research')!
    expect(registry.allowsProvider(research, 'anthropic')).toBe(true)
    expect(registry.allowsProvider(research, 'openai')).toBe(false)
  })

  it('treats an empty allowlist as every provider', () => {
    const platform = registry.resolve('tok-platform')!
    expect(registry.allowsProvider(platform, 'openai')).toBe(true)
    expect(registry.allowsProvider(platform, 'groq')).toBe(true)
  })
})

describe('TenantRegistry — quota', () => {
  it('allows requests up to the limit and refuses the next', () => {
    const registry = new TenantRegistry(config)
    const platform = registry.resolve('tok-platform')!
    const now = 1_000_000

    expect(registry.charge(platform, now).allowed).toBe(true)
    expect(registry.charge(platform, now + 1).allowed).toBe(true)
    expect(registry.charge(platform, now + 2).allowed).toBe(true)

    const refused = registry.charge(platform, now + 3)
    expect(refused.allowed).toBe(false)
    expect(refused.limit).toBe(3)
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('returns the whole budget only once the window has fully passed', () => {
    const registry = new TenantRegistry(config)
    const platform = registry.resolve('tok-platform')!
    const now = 2_000_000

    for (let i = 0; i < 3; i++) registry.charge(platform, now + i)
    expect(registry.charge(platform, now + 4).allowed).toBe(false)

    const later = now + 60_003 // strictly past all three requests
    for (let i = 0; i < 3; i++) expect(registry.charge(platform, later + i).allowed).toBe(true)
    expect(registry.charge(platform, later + 3).allowed).toBe(false)
  })

  it('frees capacity gradually as individual requests age out', () => {
    // The sliding-window property. A fixed window would reset the counter to
    // zero at the boundary, letting a caller spend two full quotas back to
    // back — the exact burst a quota exists to prevent.
    const registry = new TenantRegistry(config)
    const platform = registry.resolve('tok-platform')!
    const now = 2_500_000

    for (let i = 0; i < 3; i++) registry.charge(platform, now + i)
    expect(registry.charge(platform, now + 4).allowed).toBe(false)

    // Part of the window has aged out, so a request is admitted — but the
    // counter carries the requests that have not, rather than starting fresh.
    const partial = registry.charge(platform, now + 60_001)
    expect(partial.allowed).toBe(true)
    expect(partial.used).toBeGreaterThan(1)
    expect(partial.used).toBeLessThanOrEqual(3)
  })

  it('does not limit a tenant with no quota configured', () => {
    const registry = new TenantRegistry(config)
    const unlimited = registry.resolve('tok-unlimited')!
    for (let i = 0; i < 200; i++) {
      expect(registry.charge(unlimited, 3_000_000 + i).allowed).toBe(true)
    }
  })

  it('keeps each tenant budget separate from the others', () => {
    const registry = new TenantRegistry(config)
    const platform = registry.resolve('tok-platform')!
    const research = registry.resolve('tok-research')!
    const now = 4_000_000

    for (let i = 0; i < 3; i++) registry.charge(platform, now + i)
    expect(registry.charge(platform, now + 4).allowed).toBe(false)
    // One tenant exhausting its quota must not affect another.
    expect(registry.charge(research, now + 5).allowed).toBe(true)
  })
})

describe('TenantRegistry — enforcement', () => {
  const registry = new TenantRegistry(config)

  it('defaults a tenant to enforcing', () => {
    expect(registry.resolve('tok-platform')?.enforcement).toBe('enforce')
  })

  it('lets one tenant observe while the others enforce', () => {
    expect(registry.resolve('tok-research')?.enforcement).toBe('observe')
    expect(registry.resolve('tok-unlimited')?.enforcement).toBe('enforce')
  })
})
