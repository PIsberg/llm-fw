import type { GatewayModule, GatewayModuleContext, ModuleTransformResult, ModuleStats } from '../types.js'
import type { ModuleSwitchConfig } from '../../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { parseUsage } from '../usage.js'

/**
 * Adds up the token counts the provider reports in each response. The other
 * modules' savings are estimates made before the request leaves; this is the
 * provider's own bill, including the cache reads and writes that decide what
 * a long agent session costs. Reads responses only and changes nothing.
 */
export class UsageMeterModule implements GatewayModule {
  readonly id = 'usage-meter'
  readonly name = 'Usage Meter'
  readonly description = 'Adds up the token counts providers report in their responses: uncached input, cache reads and writes, output. Changes nothing.'

  // The live config object, so hot reload and the dashboard toggle reach it.
  private readonly cfg: ModuleSwitchConfig

  private responses = 0
  private input = 0
  private cacheRead = 0
  private cacheWrite = 0
  private output = 0

  constructor(config?: ModuleSwitchConfig) {
    this.cfg = config ?? { enabled: true }
  }

  get enabled(): boolean {
    return this.cfg.enabled
  }

  set enabled(value: boolean) {
    this.cfg.enabled = value
  }

  transformRequest(body: string): ModuleTransformResult {
    return { body, modified: false }
  }

  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    const usage = parseUsage(response.body, response.headers)
    if (!usage) return
    this.responses++
    this.input += usage.inputTokens
    this.cacheRead += usage.cacheReadTokens
    this.cacheWrite += usage.cacheWriteTokens
    this.output += usage.outputTokens
  }

  getStats(): ModuleStats {
    const allInput = this.input + this.cacheRead + this.cacheWrite
    const ratio = allInput > 0 ? Math.round((this.cacheRead / allInput) * 1000) / 10 : 0
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      totalInvocations: this.responses,
      tokensOriginal: 0,
      tokensPruned: 0,
      tokensSaved: 0,
      percentSaved: 0,
      recentEvents: [],
      kpis: [
        { key: 'responses', label: 'Responses metered', value: this.responses },
        { key: 'input', label: 'Uncached input', value: this.input },
        { key: 'cacheRead', label: 'Cache reads', value: this.cacheRead },
        { key: 'cacheWrite', label: 'Cache writes', value: this.cacheWrite },
        { key: 'output', label: 'Output', value: this.output },
        { key: 'cacheRatio', label: 'Input served from cache', value: `${ratio}%` },
      ],
    }
  }

  resetStats(): void {
    this.responses = 0
    this.input = 0
    this.cacheRead = 0
    this.cacheWrite = 0
    this.output = 0
  }
}
