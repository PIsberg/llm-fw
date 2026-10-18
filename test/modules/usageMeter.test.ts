import { describe, it, expect } from 'vitest'
import { UsageMeterModule } from '../../src/modules/builtin/usageMeter.js'
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
