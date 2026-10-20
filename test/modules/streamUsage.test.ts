import { describe, it, expect } from 'vitest'
import { StreamUsageModule } from '../../src/modules/builtin/streamUsage.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const openai: GatewayModuleContext = { target: 'api.openai.com', method: 'POST', path: '/v1/chat/completions', isLlmRequest: true, parser: null }
const request = (extra: Record<string, unknown> = {}) => ({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }], ...extra })
const send = (mod: StreamUsageModule, payload: unknown, ctx = openai) => mod.transformRequest(JSON.stringify(payload), ctx)
const kpi = (mod: StreamUsageModule, key: string) => mod.getStats().kpis?.find(k => k.key === key)?.value

// #357: an OpenAI chat completions stream reports its usage only when the
// client asks with stream_options.include_usage, and most clients do not, so
// the usage meter could not meter those streams.
describe('StreamUsageModule', () => {
  it('asks a streaming chat completions request to report its usage', () => {
    const mod = new StreamUsageModule({ enabled: true })
    const res = send(mod, request())
    expect(res.modified).toBe(true)
    expect(JSON.parse(res.body).stream_options).toEqual({ include_usage: true })
    expect(kpi(mod, 'marked')).toBe(1)
  })

  // #421: the chunk the option adds is dropped on the way to a client that
  // did not ask for it; the listener reads this flag.
  it('flags the request so the listener drops the usage chunk, only when it added the option', () => {
    // One context per request, as the listeners build them.
    const fresh = (): GatewayModuleContext => ({ target: 'api.openai.com', method: 'POST', path: '/v1/chat/completions', isLlmRequest: true, parser: null })
    const ctx = fresh()
    send(new StreamUsageModule({ enabled: true }), request(), ctx)
    expect(ctx.stripStreamUsage).toBe(true)
    const own = fresh()
    send(new StreamUsageModule({ enabled: true }), request({ stream_options: { include_usage: true } }), own)
    expect(own.stripStreamUsage).toBeUndefined()
    const observed = { ...fresh(), dryRun: true }
    send(new StreamUsageModule({ enabled: true }), request(), observed)
    expect(observed.stripStreamUsage).toBeUndefined()
  })

  it('keeps the client\'s other stream options', () => {
    const out = JSON.parse(send(new StreamUsageModule({ enabled: true }), request({ stream_options: { include_obfuscation: false } })).body)
    expect(out.stream_options).toEqual({ include_obfuscation: false, include_usage: true })
  })

  it('leaves alone a request that is not a stream, already asks, or is not chat completions', () => {
    const mod = new StreamUsageModule({ enabled: true })
    expect(send(mod, request({ stream: false })).modified).toBe(false)
    expect(send(mod, request({ stream: undefined })).modified).toBe(false)
    expect(send(mod, request({ stream_options: { include_usage: true } })).modified).toBe(false)
    expect(kpi(mod, 'clientManaged')).toBe(1)
    expect(send(mod, request({ stream_options: 'odd' })).modified).toBe(false)
    expect(send(mod, { model: 'gpt-4o', stream: true, input: 'hi' }, { ...openai, path: '/v1/responses' }).modified).toBe(false)
    expect(send(mod, request(), { ...openai, target: 'api.anthropic.com', path: '/v1/messages' }).modified).toBe(false)
    expect(kpi(mod, 'marked')).toBe(0)
  })

  it('covers OpenAI-compatible hosts by the path, query included', () => {
    const mod = new StreamUsageModule({ enabled: true })
    const groq = send(mod, request(), { ...openai, target: 'api.groq.com', path: '/openai/v1/chat/completions?x=1' })
    expect(JSON.parse(groq.body).stream_options).toEqual({ include_usage: true })
  })

  it('counts a dry run in observe mode without claiming it was sent', () => {
    const mod = new StreamUsageModule({ enabled: true })
    send(mod, request(), { ...openai, dryRun: true })
    expect(kpi(mod, 'wouldMark')).toBe(1)
    expect(kpi(mod, 'marked')).toBe(0)
  })

  it('is off by default and takes the switch live', () => {
    const cfg = { enabled: false }
    const mod = new StreamUsageModule(cfg)
    expect(send(mod, request()).modified).toBe(false)
    cfg.enabled = true
    expect(send(mod, request()).modified).toBe(true)
  })
})
