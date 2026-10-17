import { describe, it, expect } from 'vitest'
import { ResponseCacheModule } from '../../src/modules/builtin/responseCache.js'
import { ModuleManager } from '../../src/modules/registry.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import type { CapturedResponse } from '../../src/modules/responseTap.js'
import type { ResponseCacheConfig } from '../../src/types.js'

const ctx = (headers: Record<string, string> = {}): GatewayModuleContext => ({
  target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null,
  headers: { 'x-api-key': 'sk-one', 'anthropic-version': '2023-06-01', ...headers },
})
const body = JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'What is 2+2?' }] })
const ok = (text = '4'): CapturedResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
  body: Buffer.from(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 15, output_tokens: 5 } })),
})
const cfg = (extra: Partial<ResponseCacheConfig> = {}): ResponseCacheConfig => ({ enabled: true, ttlSeconds: 300, maxEntries: 100, maxEntryBytes: 524288, ...extra })
const kpi = (mod: ResponseCacheModule, key: string) => mod.getStats().kpis?.find(k => k.key === key)?.value

describe('ResponseCacheModule', () => {
  it('answers a repeated request with the stored response', () => {
    const mod = new ResponseCacheModule(cfg())
    expect(mod.respond(body, ctx())).toBeUndefined()
    mod.observeResponse(body, ctx(), ok())
    const hit = mod.respond(body, ctx())
    expect(hit?.response.status).toBe(200)
    expect(hit?.response.body.toString()).toBe(ok().body.toString())
    expect(hit?.response.headers['x-llm-fw-cache']).toBe('hit')
    expect(kpi(mod, 'hits')).toBe(1)
    expect(kpi(mod, 'misses')).toBe(1)
  })

  it('counts the billed tokens a hit avoided, from the stored usage', () => {
    const mod = new ResponseCacheModule(cfg())
    mod.observeResponse(body, ctx(), ok())
    const hit = mod.respond(body, ctx())
    expect(hit?.events?.[0]?.tokensSaved).toBe(20)
    expect(mod.getStats().tokensSaved).toBe(20)
  })

  it('never serves one credential a response fetched with another', () => {
    const mod = new ResponseCacheModule(cfg())
    mod.observeResponse(body, ctx(), ok())
    expect(mod.respond(body, ctx({ 'x-api-key': 'sk-two' }))).toBeUndefined()
    expect(mod.respond(body, ctx({ authorization: 'Bearer other' }))).toBeUndefined()
    expect(mod.respond(body, { ...ctx(), tenant: 'team-b' })).toBeUndefined()
  })

  it('never serves a response fetched with a credential in the query or a cookie to another caller', () => {
    // Google documents its key as ?key=; the gateway's path is the route
    // without the query, so the query must be keyed through the full URL.
    const mod = new ResponseCacheModule(cfg())
    const gemini = (url: string, headers: Record<string, string> = {}): GatewayModuleContext =>
      ({ ...ctx(headers), headers: { ...headers }, target: 'generativelanguage.googleapis.com', path: '/v1beta/models/g:generateContent', url })
    mod.observeResponse(body, gemini('/gemini/v1beta/models/g:generateContent?key=AIza-one'), ok())
    expect(mod.respond(body, gemini('/gemini/v1beta/models/g:generateContent?key=AIza-one'))).toBeDefined()
    expect(mod.respond(body, gemini('/gemini/v1beta/models/g:generateContent?key=AIza-two'))).toBeUndefined()
    mod.observeResponse(body, gemini('/x', { cookie: 'session=a' }), ok())
    expect(mod.respond(body, gemini('/x', { cookie: 'session=b' }))).toBeUndefined()
  })

  it('neither stores nor answers a request that carries no credential', () => {
    const mod = new ResponseCacheModule(cfg())
    const anonymous: GatewayModuleContext = { ...ctx(), headers: { 'anthropic-version': '2023-06-01' } }
    mod.observeResponse(body, anonymous, ok())
    expect(kpi(mod, 'entries')).toBe(0)
    expect(mod.respond(body, anonymous)).toBeUndefined()
  })

  it('keeps clients apart by session as well as by credential', () => {
    const mod = new ResponseCacheModule(cfg())
    mod.observeResponse(body, { ...ctx(), sessionKey: '10.0.0.1' }, ok())
    expect(mod.respond(body, { ...ctx(), sessionKey: '10.0.0.1' })).toBeDefined()
    expect(mod.respond(body, { ...ctx(), sessionKey: '10.0.0.2' })).toBeUndefined()
  })

  it('does not replay one session\'s cookies to the next request', () => {
    const mod = new ResponseCacheModule(cfg())
    mod.observeResponse(body, ctx(), { ...ok(), headers: { ...ok().headers, 'set-cookie': '__cf_bm=abc; HttpOnly' } })
    expect(mod.respond(body, ctx())?.response.headers['set-cookie']).toBeUndefined()
  })

  it('keys on everything that shapes the answer: body, path, version and encoding', () => {
    const mod = new ResponseCacheModule(cfg())
    mod.observeResponse(body, ctx(), ok())
    expect(mod.respond(body.replace('2+2', '2+3'), ctx())).toBeUndefined()
    expect(mod.respond(body, { ...ctx(), path: '/v1/messages?beta=true' })).toBeUndefined()
    expect(mod.respond(body, ctx({ 'anthropic-beta': 'x' }))).toBeUndefined()
    expect(mod.respond(body, ctx({ 'accept-encoding': 'gzip' }))).toBeUndefined()
    // A header that does not shape the answer does not split the cache.
    expect(mod.respond(body, ctx({ 'user-agent': 'other/2.0', 'x-request-id': 'r9' }))).toBeDefined()
  })

  it('stores only complete 200 responses within the size cap', () => {
    const mod = new ResponseCacheModule(cfg({ maxEntryBytes: 100 }))
    mod.observeResponse(body, ctx(), { ...ok(), status: 529 })
    mod.observeResponse(body, ctx(), { ...ok(), body: Buffer.alloc(101, 32) })
    expect(mod.respond(body, ctx())).toBeUndefined()
    expect(kpi(mod, 'entries')).toBe(0)
  })

  it('forgets an entry after its live TTL', () => {
    let now = 1_000_000
    const config = cfg({ ttlSeconds: 60 })
    const mod = new ResponseCacheModule(config, () => now)
    mod.observeResponse(body, ctx(), ok())
    now += 59_000
    expect(mod.respond(body, ctx())).toBeDefined()
    config.ttlSeconds = 30
    expect(mod.respond(body, ctx())).toBeUndefined()
  })

  it('evicts the least recently used entry past maxEntries', () => {
    const mod = new ResponseCacheModule(cfg({ maxEntries: 2 }))
    const req = (n: number) => body.replace('2+2', `${n}+${n}`)
    mod.observeResponse(req(1), ctx(), ok())
    mod.observeResponse(req(2), ctx(), ok())
    mod.respond(req(1), ctx())
    mod.observeResponse(req(3), ctx(), ok())
    expect(mod.respond(req(1), ctx())).toBeDefined()
    expect(mod.respond(req(2), ctx())).toBeUndefined()
    expect(mod.respond(req(3), ctx())).toBeDefined()
  })

  it('never answers under observe mode, which promises the provider sees every request', () => {
    const mod = new ResponseCacheModule(cfg())
    mod.observeResponse(body, ctx(), ok())
    expect(mod.respond(body, { ...ctx(), dryRun: true })).toBeUndefined()
  })
})

describe('ModuleManager — respond', () => {
  it('asks enabled modules only, and survives one that throws', () => {
    const mgr = new ModuleManager(undefined, false)
    const cache = new ResponseCacheModule(cfg())
    mgr.register({
      id: 'throws', name: 'Throws', description: '', enabled: true,
      transformRequest: (b) => ({ body: b, modified: false }),
      respond: () => { throw new Error('module bug') },
      getStats: () => cache.getStats(),
    })
    mgr.register(cache)
    cache.observeResponse(body, ctx(), ok())
    expect(mgr.respond(body, ctx())?.response.status).toBe(200)
    cache.enabled = false
    expect(mgr.respond(body, ctx())).toBeUndefined()
  })
})
