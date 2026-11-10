import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UsageMeterModule } from '../../src/modules/builtin/usageMeter.js'
import { estimateTokens } from '../../src/modules/tokens.js'
import { ModuleManager } from '../../src/modules/registry.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { GatewayModuleContext, ModuleStats } from '../../src/modules/types.js'
import type { CapturedResponse } from '../../src/modules/responseTap.js'
import type { Config } from '../../src/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const anthropic = (usage: Record<string, number>): CapturedResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ type: 'message', usage })),
})
const kpi = (stats: ModuleStats, key: string) => stats.kpis?.find(k => k.key === key)?.value

describe('UsageMeterModule', () => {
  it('adds up what the provider reports, response by response', () => {
    const meter = new UsageMeterModule({ enabled: true })
    meter.observeResponse('{}', ctx, anthropic({ input_tokens: 10, cache_read_input_tokens: 990, cache_creation_input_tokens: 0, output_tokens: 5 }))
    meter.observeResponse('{}', ctx, anthropic({ input_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 7 }))

    const stats = meter.getStats()
    expect(kpi(stats, 'responses')).toBe(2)
    expect(kpi(stats, 'input')).toBe(40)
    expect(kpi(stats, 'cacheRead')).toBe(990)
    expect(kpi(stats, 'cacheWrite')).toBe(1000)
    expect(kpi(stats, 'output')).toBe(12)
    // 990 of 2,030 input tokens were served from the cache.
    expect(kpi(stats, 'cacheRatio')).toBe('48.8%')
  })

  it('skips a response that carries no usage', () => {
    const meter = new UsageMeterModule({ enabled: true })
    meter.observeResponse('{}', ctx, { status: 529, headers: {}, body: Buffer.from('{"error":{}}') })
    expect(kpi(meter.getStats(), 'responses')).toBe(0)
  })

  // #356: the module cards count savings with an estimate fitted to public
  // tokenizers, not Claude's. The meter sees the billed input of each
  // response, so it shows how the two compare on the traffic it meters.
  it('compares the billed input with the estimate over the request text', () => {
    const meter = new UsageMeterModule({ enabled: true })
    const text = 'word '.repeat(400)
    const request = JSON.stringify({ model: 'claude-opus-5-5', system: text, messages: [{ role: 'user', content: text }] })
    const estimated = estimateTokens(text) * 2
    meter.observeResponse(request, ctx, anthropic({ input_tokens: 100, cache_read_input_tokens: estimated, cache_creation_input_tokens: 50, output_tokens: 5 }))
    const stats = meter.getStats()
    expect(kpi(stats, 'estimateRatio')).toBe(((estimated + 150) / estimated).toFixed(2))
    expect(kpi(stats, 'compared')).toBe(1)

    // A request whose history the server holds is billed for text it does
    // not carry, so it is left out of the comparison; so is one with no text.
    meter.observeResponse(JSON.stringify({ thread: { type: 'continue', previous_message_id: 'm' }, messages: [{ role: 'user', content: 'x' }] }), ctx, anthropic({ input_tokens: 90000, output_tokens: 1 }))
    meter.observeResponse(JSON.stringify({ previous_response_id: 'r', input: 'x' }), ctx, anthropic({ input_tokens: 90000, output_tokens: 1 }))
    meter.observeResponse('{}', ctx, anthropic({ input_tokens: 90000, output_tokens: 1 }))
    expect(kpi(meter.getStats(), 'compared')).toBe(1)
    expect(kpi(meter.getStats(), 'responses')).toBe(4)
  })

  it('shows no ratio before a response could be compared', () => {
    const meter = new UsageMeterModule({ enabled: true })
    expect(kpi(meter.getStats(), 'estimateRatio')).toBe('n/a')
  })

  it('never rewrites a request and saves nothing, so the savings totals stay honest', () => {
    const meter = new UsageMeterModule({ enabled: true })
    expect(meter.transformRequest('{"messages":[]}', ctx)).toEqual({ body: '{"messages":[]}', modified: false })
    expect(meter.getStats().tokensSaved).toBe(0)
    expect(meter.getStats().tokensOriginal).toBe(0)
  })
})

describe('ModuleManager — responses', () => {
  it('meters responses by default: reading usage changes no traffic', () => {
    const mgr = new ModuleManager(structuredClone(DEFAULT_CONFIG) as Config)
    expect(mgr.getModule('usage-meter')?.enabled).toBe(true)
    expect(mgr.wantsResponses()).toBe(true)
  })

  it('hands a response only to enabled modules, and survives one that throws', () => {
    const config = structuredClone(DEFAULT_CONFIG) as Config
    const mgr = new ModuleManager(config)
    mgr.register({
      id: 'throws', name: 'Throws', description: '', enabled: true,
      transformRequest: (body) => ({ body, modified: false }),
      observeResponse: () => { throw new Error('module bug') },
      getStats: () => mgr.getModule('usage-meter')!.getStats(),
    })
    mgr.observeResponse('{}', ctx, anthropic({ input_tokens: 1, output_tokens: 1 }))
    expect(kpi(mgr.getModule('usage-meter')!.getStats(), 'responses')).toBe(1)

    mgr.setModuleEnabled('usage-meter', false)
    // The other response reader that is on by default.
    mgr.setModuleEnabled('tool-usage', false)
    mgr.setModuleEnabled('throws', false)
    expect(mgr.wantsResponses()).toBe(false)
    mgr.observeResponse('{}', ctx, anthropic({ input_tokens: 1, output_tokens: 1 }))
    expect(kpi(mgr.getModule('usage-meter')!.getStats(), 'responses')).toBe(1)
    expect(config.modules?.usageMeter?.enabled).toBe(false)
  })
})

// #746: the Prompt Cache Marker's shortTtlClients pays for a client whose
// conversations never idle five minutes and costs a rewrite each time one
// does. The meter keeps the evidence per client, so the list is not a guess.
describe('UsageMeterModule cache entries by client', () => {
  const MIN = 60_000
  const marker = { enabled: false, ttl: '5m' as const, cacheSystem: true, shortTtlClients: [] as string[], shortTtlScope: 'messages' as const }
  const setup = (cacheControl: typeof marker | undefined = { ...marker }) => {
    const clock = { now: 1_000_000 }
    const meter = new UsageMeterModule({ enabled: true }, () => cacheControl, () => clock.now)
    const call = (agent: string | undefined, session: string | undefined, usage: { read?: number; write1h?: number; write5m?: number }) => meter.observeResponse('{}', {
      ...ctx,
      headers: { ...(agent ? { 'user-agent': agent } : {}), ...(session ? { 'x-claude-code-session-id': session } : {}) },
    }, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ type: 'message', usage: {
        input_tokens: 2, output_tokens: 5, cache_read_input_tokens: usage.read ?? 0,
        cache_creation_input_tokens: (usage.write1h ?? 0) + (usage.write5m ?? 0),
        cache_creation: { ephemeral_1h_input_tokens: usage.write1h ?? 0, ephemeral_5m_input_tokens: usage.write5m ?? 0 },
      } })),
    })
    return { meter, clock, call, cacheControl }
  }
  const print = 'claude-cli/2.1.321 (external, sdk-cli)'
  const interactive = 'claude-cli/2.1.321 (external, cli)'
  // n print-mode runs of three calls a few seconds apart, 10,000 tokens written at one hour each.
  const printRuns = (s: ReturnType<typeof setup>, n: number, from = 0) => {
    for (let i = from; i < from + n; i++) {
      s.call(print, `p${i}`, { write1h: 8000 })
      s.clock.now += 5000
      s.call(print, `p${i}`, { read: 8000, write1h: 1000 })
      s.clock.now += 5000
      s.call(print, `p${i}`, { read: 9000, write1h: 1000 })
      s.clock.now += 30 * MIN
    }
  }

  it('counts conversations, the ones that idled five minutes, and one-hour writes, per client', () => {
    const s = setup()
    printRuns(s, 3)
    s.call(interactive, 'i1', { write1h: 50_000 })
    s.clock.now += 4 * MIN
    s.call(interactive, 'i1', { read: 50_000, write1h: 2000 })
    s.clock.now += 7 * MIN
    s.call(interactive, 'i1', { read: 52_000, write1h: 2000 })
    s.clock.now += 9 * MIN
    s.call(interactive, 'i1', { read: 54_000, write1h: 1000 })
    const detail = s.meter.getStats().detail!
    expect(detail).toContain('claude-cli (sdk-cli): 3 conversations, 0 idled 5 minutes or more, 30,000 one-hour cache-write tokens, five-minute entries would have cost 22,500 input tokens less')
    // 55,000 x 0.75 saved, 106,000 x 1.15 written again after the two gaps.
    expect(detail).toContain('claude-cli (cli): 1 conversations, 1 idled 5 minutes or more, 55,000 one-hour cache-write tokens, five-minute entries would have cost 80,650 input tokens more')
  })

  it('offers a client to the Prompt Cache Marker after 50 conversations that never idled', () => {
    const s = setup()
    printRuns(s, 49)
    expect(s.meter.getStats().action).toBeUndefined()
    expect(s.meter.getStats().detail).toContain('after 50 conversations (49 so far)')
    printRuns(s, 1, 49)
    expect(s.meter.getStats().action).toEqual({
      label: 'Use five-minute cache entries for sdk-cli',
      module: 'cache-control',
      enabled: true,
      options: { shortTtlClients: ['sdk-cli'] },
    })
    // Named already, and the marker is on: nothing left to offer.
    s.cacheControl!.shortTtlClients = ['SDK-CLI']
    s.cacheControl!.enabled = true
    expect(s.meter.getStats().action).toBeUndefined()
  })

  // Found live: a name left in the list while the Prompt Cache Marker is
  // switched off shortens nothing, so the client is not "named" yet.
  it('still offers a client that is listed while the Prompt Cache Marker is off, without listing it twice', () => {
    const s = setup({ ...marker, enabled: false, shortTtlClients: ['other', 'sdk-cli'] })
    printRuns(s, 50)
    expect(s.meter.getStats().detail).toContain('500,000 one-hour cache-write tokens')
    expect(s.meter.getStats().action).toEqual({
      label: 'Use five-minute cache entries for sdk-cli',
      module: 'cache-control',
      enabled: true,
      options: { shortTtlClients: ['other', 'sdk-cli'] },
    })
  })

  it('does not offer a client whose conversations idle', () => {
    const s = setup()
    for (let i = 0; i < 60; i++) {
      s.call(interactive, `i${i}`, { write1h: 20_000 })
      s.clock.now += 6 * MIN
      s.call(interactive, `i${i}`, { read: 20_000, write1h: 1000 })
      s.clock.now += 2 * MIN
    }
    expect(s.meter.getStats().action).toBeUndefined()
    expect(s.meter.getStats().detail).toContain('60 idled 5 minutes or more')
  })

  it('keeps the offer when a few conversations idled and the saving is four times the cost', () => {
    const s = setup()
    printRuns(s, 60)
    s.call(print, 'slow', { write1h: 10_000 })
    s.clock.now += 6 * MIN
    s.call(print, 'slow', { read: 10_000, write1h: 500 })
    expect(s.meter.getStats().detail).toContain('61 conversations, 1 idled')
    expect(s.meter.getStats().action?.options).toEqual({ shortTtlClients: ['sdk-cli'] })
  })

  it('counts a gap of an hour or more as a pause both lifetimes lose', () => {
    const s = setup()
    s.call(print, 'a', { write1h: 10_000 })
    s.clock.now += 61 * MIN
    s.call(print, 'a', { write1h: 10_500 })
    expect(s.meter.getStats().detail).toContain('1 idled 5 minutes or more, 20,500 one-hour cache-write tokens, five-minute entries would have cost 15,375 input tokens less')
  })

  it('says how often a named client found its five-minute entries expired', () => {
    const s = setup({ ...marker, enabled: true, shortTtlClients: ['sdk-cli'] })
    s.call(print, 'a', { write5m: 10_000 })
    s.clock.now += 6 * MIN
    s.call(print, 'a', { write5m: 10_500 })
    s.clock.now += 5000
    s.call(print, 'a', { read: 10_500, write5m: 500 })
    expect(s.meter.getStats().detail).toContain('named in shortTtlClients; a call followed 5 idle minutes 1 times')
  })

  it('names a client that is not Claude Code by its product, and skips a request with no session or no agent', () => {
    const s = setup()
    s.call('my-agent/1.0', 's1', { write1h: 100 })
    s.call(undefined, 's2', { write1h: 100 })
    s.call('curl/8.0', undefined, { write1h: 100 })
    const detail = s.meter.getStats().detail!
    expect(detail).toContain('my-agent: 1 conversations')
    expect(detail).not.toContain('curl')
    expect(kpi(s.meter.getStats(), 'responses')).toBe(3)
  })

  it('says nothing about clients before one sent a session id, and forgets them on reset', () => {
    const s = setup()
    expect(s.meter.getStats().detail).toBeUndefined()
    printRuns(s, 2)
    s.meter.resetStats()
    expect(s.meter.getStats().detail).toBeUndefined()
  })

  it('remembers a bounded number of conversations and clients', () => {
    const s = setup()
    for (let i = 0; i < 6000; i++) s.call(print, `p${i}`, { write1h: 10 })
    s.clock.now += 6 * MIN
    // The oldest conversation was forgotten: its next call starts a new one.
    s.call(print, 'p0', { read: 10 })
    expect(s.meter.getStats().detail).toContain('6,001 conversations, 0 idled')
    for (let i = 0; i < 300; i++) s.call(`agent-${i}/1`, `x${i}`, { write1h: 10 })
    expect(s.meter.getStats().detail!.split('; ').length).toBeLessThanOrEqual(21)
  })

  it('keeps the totals per client across a restart', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-usage-clients-'))
    try {
      const file = join(dir, 'usage-clients.json')
      const first = setup()
      first.meter.persistTo(file)
      printRuns(first, 50)
      first.meter.flush()
      const second = setup()
      second.meter.persistTo(file)
      expect(second.meter.getStats().detail).toContain('claude-cli (sdk-cli): 50 conversations, 0 idled')
      expect(second.meter.getStats().action?.options).toEqual({ shortTtlClients: ['sdk-cli'] })
      fs.writeFileSync(file, '{not json')
      const third = setup()
      third.meter.persistTo(file)
      expect(third.meter.getStats().detail).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
