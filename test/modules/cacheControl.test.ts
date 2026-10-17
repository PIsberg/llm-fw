import { describe, it, expect } from 'vitest'
import { CacheControlModule } from '../../src/modules/builtin/cacheControl.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import type { CacheControlConfig } from '../../src/types.js'

const anthropic: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const cfg = (extra: Partial<CacheControlConfig> = {}): CacheControlConfig => ({ enabled: true, ttl: '5m', cacheSystem: true, ...extra })
const request = (extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  system: 'You are a careful assistant.',
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
})
const send = (mod: CacheControlModule, payload: unknown, ctx = anthropic) => mod.transformRequest(JSON.stringify(payload), ctx)
const kpi = (mod: CacheControlModule, key: string) => mod.getStats().kpis?.find(k => k.key === key)?.value

describe('CacheControlModule', () => {
  it('turns on automatic caching and marks the system prompt', () => {
    const res = send(new CacheControlModule(cfg()), request())
    expect(res.modified).toBe(true)
    const out = JSON.parse(res.body)
    expect(out.cache_control).toEqual({ type: 'ephemeral' })
    expect(out.system).toEqual([{ type: 'text', text: 'You are a careful assistant.', cache_control: { type: 'ephemeral' } }])
    expect(out.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('marks the last block of a block system prompt', () => {
    const out = JSON.parse(send(new CacheControlModule(cfg()), request({
      system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    })).body)
    expect(out.system).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }])
  })

  it('uses the one-hour TTL on both markers when asked', () => {
    const out = JSON.parse(send(new CacheControlModule(cfg({ ttl: '1h' })), request()).body)
    expect(out.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(out.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('leaves the system prompt alone when cacheSystem is off', () => {
    const out = JSON.parse(send(new CacheControlModule(cfg({ cacheSystem: false })), request()).body)
    expect(out.cache_control).toEqual({ type: 'ephemeral' })
    expect(out.system).toBe('You are a careful assistant.')
  })

  it('leaves a request that already places markers alone, wherever they are', () => {
    const mod = new CacheControlModule(cfg())
    const marked = [
      request({ cache_control: { type: 'ephemeral' } }),
      request({ system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] }),
      request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] }] }),
      request({ tools: [{ name: 't', input_schema: {}, cache_control: { type: 'ephemeral' } }] }),
    ]
    for (const payload of marked) expect(send(mod, payload).modified).toBe(false)
    expect(kpi(mod, 'clientManaged')).toBe(4)
    expect(kpi(mod, 'marked')).toBe(0)
  })

  it('accepts the query string Claude Code sends', () => {
    expect(send(new CacheControlModule(cfg()), request(), { ...anthropic, path: '/v1/messages?beta=true' }).modified).toBe(true)
  })

  it('only touches Anthropic Messages requests', () => {
    const mod = new CacheControlModule(cfg())
    expect(send(mod, request(), { ...anthropic, target: 'api.openai.com' }).modified).toBe(false)
    expect(send(mod, request(), { ...anthropic, path: '/v1/messages/count_tokens' }).modified).toBe(false)
    expect(send(mod, { prompt: 'x' }).modified).toBe(false)
  })

  it('counts what it marked, and adds no savings it cannot measure', () => {
    const mod = new CacheControlModule(cfg())
    const res = send(mod, request())
    expect(kpi(mod, 'marked')).toBe(1)
    expect(mod.getStats().tokensSaved).toBe(0)
    expect(res.events ?? []).toHaveLength(0)
  })
})
