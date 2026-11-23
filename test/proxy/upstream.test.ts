import { describe, it, expect, vi } from 'vitest'
import { UpstreamResolver, MAX_RESOLVER_CACHE } from '../../src/proxy/upstream.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

// #866: the resolver asked the public resolvers for an A record only, took
// the first address, refused an IP literal, failed outright when outbound
// DNS was blocked or the host lived in a private zone, and cached without a
// bound.
const config = DEFAULT_CONFIG.proxy
const notFound = () => Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' })

function deps(over: Partial<{ resolve4: (h: string) => Promise<string[]>; resolve6: (h: string) => Promise<string[]>; lookup: (h: string) => Promise<{ address: string; family: number }[]> }> = {}) {
  return {
    resolve4: vi.fn(over.resolve4 ?? (async () => ['203.0.113.10', '203.0.113.11'])),
    resolve6: vi.fn(over.resolve6 ?? (async () => { throw notFound() })),
    lookup: vi.fn(over.lookup ?? (async () => { throw notFound() })),
  }
}

describe('UpstreamResolver (#866)', () => {
  it('returns an IP literal as it is, without asking DNS', async () => {
    const d = deps()
    const r = new UpstreamResolver(config, d)
    expect(await r.resolve('198.51.100.7')).toBe('198.51.100.7')
    expect(await r.resolve('2001:db8::5')).toBe('2001:db8::5')
    expect(d.resolve4).not.toHaveBeenCalled()
  })

  it('caches an answer', async () => {
    const d = deps()
    const r = new UpstreamResolver(config, d)
    await r.resolve('api.example.com')
    await r.resolve('api.example.com')
    expect(d.resolve4).toHaveBeenCalledOnce()
  })

  it('falls back to AAAA when a host has no A record', async () => {
    const r = new UpstreamResolver(config, deps({ resolve4: async () => { throw notFound() }, resolve6: async () => ['2001:db8::10'] }))
    expect(await r.resolve('v6only.example.com')).toBe('2001:db8::10')
  })

  it('falls back to the system resolver for a name public DNS cannot answer, a private zone', async () => {
    const r = new UpstreamResolver(config, deps({
      resolve4: async () => { throw notFound() },
      lookup: async () => [{ address: '10.20.0.5', family: 4 }],
    }))
    expect(await r.resolve('llm.corp.internal')).toBe('10.20.0.5')
  })

  it('never takes a loopback answer from the system resolver, where a sinkhole points provider hosts', async () => {
    const r = new UpstreamResolver(config, deps({
      resolve4: async () => { throw notFound() },
      lookup: async () => [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }],
    }))
    await expect(r.resolve('api.anthropic.com')).rejects.toThrow(/api\.anthropic\.com/)
  })

  it('moves to the next address after one fails, and asks again once all have', async () => {
    const d = deps()
    const r = new UpstreamResolver(config, d)
    expect(await r.resolve('api.example.com')).toBe('203.0.113.10')
    r.markFailed('api.example.com', '203.0.113.10')
    expect(await r.resolve('api.example.com')).toBe('203.0.113.11')
    r.markFailed('api.example.com', '203.0.113.11')
    expect(await r.resolve('api.example.com')).toBe('203.0.113.10')
    expect(d.resolve4).toHaveBeenCalledTimes(2)
  })

  it(`holds at most ${MAX_RESOLVER_CACHE} hosts`, async () => {
    const r = new UpstreamResolver(config, deps())
    for (let i = 0; i < MAX_RESOLVER_CACHE + 100; i++) await r.resolve(`h${i}.example.com`)
    expect(r.cacheSize).toBeLessThanOrEqual(MAX_RESOLVER_CACHE)
  })
})
