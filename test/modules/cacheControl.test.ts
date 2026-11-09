import { describe, it, expect } from 'vitest'
import { CacheControlModule } from '../../src/modules/builtin/cacheControl.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import type { CacheControlConfig } from '../../src/types.js'

const anthropic: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const cfg = (extra: Partial<CacheControlConfig> = {}): CacheControlConfig => ({ enabled: true, ttl: '5m', cacheSystem: true, shortTtlClients: [], shortTtlScope: 'messages', ...extra })
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

  it('counts an observe-mode request apart, since the original body went upstream', () => {
    const mod = new CacheControlModule(cfg())
    send(mod, request(), { ...anthropic, dryRun: true })
    expect(kpi(mod, 'marked')).toBe(0)
    expect(kpi(mod, 'wouldMark')).toBe(1)
  })
})

// Claude Code asks for one-hour entries on every breakpoint. A print-mode run
// (`claude -p`) never idles five minutes, so the doubled write price buys
// nothing there: 27.2% of the bill of 577 such runs on one developer's
// transcripts. shortTtlClients names the clients whose markers go to 5m.
describe('CacheControlModule shortTtlClients', () => {
  const hour = { type: 'ephemeral', ttl: '1h' }
  const five = { type: 'ephemeral' }
  const printMode = { ...anthropic, path: '/v1/messages?beta=true', headers: { 'user-agent': 'claude-cli/2.1.321 (external, sdk-cli)' } }
  const interactive = { ...anthropic, headers: { 'user-agent': 'claude-cli/2.1.321 (external, cli)' } }
  // The shape Claude Code 2.1.321 sends: two system breakpoints, one on the
  // newest message.
  const claudeCode = (extra: Record<string, unknown> = {}) => ({
    model: 'claude-haiku-5-5',
    tools: [{ name: 'Bash', description: 'd', input_schema: { type: 'object' } }],
    system: [{ type: 'text', text: 'billing' }, { type: 'text', text: 'core', cache_control: { ...hour, scope: 'global' } }, { type: 'text', text: 'env', cache_control: { ...hour } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'context' }, { type: 'text', text: 'task', cache_control: { ...hour } }] },
    ],
    ...extra,
  })
  const short = (extra: Partial<CacheControlConfig> = {}) => new CacheControlModule(cfg({ shortTtlClients: ['sdk-cli'], shortTtlScope: 'messages', ...extra }))

  it('moves a named client\'s message breakpoints to five minutes and leaves the system prompt\'s at one hour', () => {
    const res = send(short(), claudeCode(), printMode)
    expect(res.modified).toBe(true)
    const out = JSON.parse(res.body)
    expect(out.messages[0].content[1]).toEqual({ type: 'text', text: 'task', cache_control: five })
    expect(out.system).toEqual(claudeCode().system)
    expect(out.tools).toEqual(claudeCode().tools)
    expect(out.cache_control).toBeUndefined()
  })

  it('finds a breakpoint on a tool result, inside one, and at the top level', () => {
    const out = JSON.parse(send(short(), claudeCode({
      cache_control: { ...hour },
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { cache_control: { ...hour } } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out', cache_control: { ...hour } }], cache_control: { ...hour } }] },
      ],
    }), printMode).body)
    expect(out.cache_control).toEqual(five)
    expect(out.messages[2].content[0].cache_control).toEqual(five)
    expect(out.messages[2].content[0].content[0].cache_control).toEqual(five)
    // A tool's own argument named cache_control is the model's data.
    expect(out.messages[1].content[0].input).toEqual({ cache_control: hour })
  })

  it('moves every breakpoint under scope "all", keeping what else the marker says', () => {
    const tools = [{ name: 'Bash', description: 'd', input_schema: { type: 'object' }, cache_control: { ...hour } }]
    const out = JSON.parse(send(short({ shortTtlScope: 'all' }), claudeCode({ tools }), printMode).body)
    expect(out.tools[0].cache_control).toEqual(five)
    expect(out.system[1].cache_control).toEqual({ type: 'ephemeral', scope: 'global' })
    expect(out.system[2].cache_control).toEqual(five)
    expect(out.messages[0].content[1].cache_control).toEqual(five)
  })

  it('leaves every other client alone, and everyone while the list is empty', () => {
    expect(send(short(), claudeCode(), interactive).modified).toBe(false)
    expect(send(short(), claudeCode(), anthropic).modified).toBe(false)
    expect(send(new CacheControlModule(cfg({ shortTtlClients: [], shortTtlScope: 'all' })), claudeCode(), printMode).modified).toBe(false)
    expect(send(new CacheControlModule(cfg()), claudeCode(), printMode).modified).toBe(false)
  })

  it('matches the user-agent without regard to case, and ignores an empty name', () => {
    expect(send(short({ shortTtlClients: ['SDK-CLI'] }), claudeCode(), printMode).modified).toBe(true)
    expect(send(short({ shortTtlClients: [''] }), claudeCode(), printMode).modified).toBe(false)
    expect(send(short({ shortTtlClients: ['sdk-cli'] }), claudeCode(), { ...anthropic, headers: { 'user-agent': ['other', 'claude-cli/2 (external, sdk-cli)'] } }).modified).toBe(true)
  })

  it('changes nothing when the breakpoints are already five-minute ones', () => {
    const body = claudeCode({ messages: [{ role: 'user', content: [{ type: 'text', text: 'task', cache_control: { type: 'ephemeral', ttl: '5m' } }] }] })
    expect(send(short(), body, printMode).modified).toBe(false)
  })

  it('sends a growing conversation the same earlier turns', () => {
    const turn = (n: number) => ({ role: 'user', content: [{ type: 'text', text: `turn ${n}` }] })
    const marked = (n: number) => ({ role: 'user', content: [{ type: 'text', text: `turn ${n}`, cache_control: { ...hour } }] })
    const one = JSON.parse(send(short(), claudeCode({ messages: [marked(1)] }), printMode).body)
    const two = JSON.parse(send(short(), claudeCode({ messages: [turn(1), { role: 'assistant', content: 'ok' }, marked(2)] }), printMode).body)
    expect(two.system).toEqual(one.system)
    expect(two.messages[2].content[0].cache_control).toEqual(five)
  })

  it('still marks a named client\'s request that carries no breakpoint, with the configured TTL', () => {
    const out = JSON.parse(send(short({ ttl: '1h' }), request(), printMode).body)
    expect(out.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('counts the requests and the breakpoints it shortened, and claims no token saving', () => {
    const mod = short()
    send(mod, claudeCode(), printMode)
    send(mod, claudeCode(), interactive)
    expect(kpi(mod, 'shortened')).toBe(1)
    expect(kpi(mod, 'shortenedMarkers')).toBe(1)
    expect(kpi(mod, 'clientManaged')).toBe(1)
    expect(mod.getStats().tokensSaved).toBe(0)
  })

  it('counts an observe-mode request apart', () => {
    const mod = short()
    send(mod, claudeCode(), { ...printMode, dryRun: true })
    expect(kpi(mod, 'shortened')).toBe(0)
    expect(kpi(mod, 'wouldShorten')).toBe(1)
  })
})
