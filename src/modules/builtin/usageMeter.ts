import type { GatewayModule, GatewayModuleContext, ModuleTransformResult, ModuleStats } from '../types.js'
import type { ModuleSwitchConfig } from '../../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { parseUsage } from '../usage.js'
import { parsePayload } from '../base.js'
import { collectTextSlots } from '../payload.js'
import { estimateTokens } from '../tokens.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// The estimate over a request's text, for comparison with what was billed
// for it; undefined when the request carries no text, or when the server
// holds history the request does not carry (a thread continuation, a
// Responses API request with previous_response_id), which is billed too.
function estimatedText(requestBody: string): number | undefined {
  const payload = parsePayload(requestBody)
  if (!payload) return undefined
  if ((isObj(payload.thread) && payload.thread.type === 'continue') || typeof payload.previous_response_id === 'string') return undefined
  const n = collectTextSlots(payload).reduce((sum, slot) => sum + estimateTokens(slot.text), 0)
  return n > 0 ? n : undefined
}

/**
 * Adds up the token counts the provider reports in each response. The other
 * modules' savings are estimates made before the request leaves; this is the
 * provider's own bill, including the cache reads and writes that decide what
 * a long agent session costs. Reads responses only and changes nothing.
 *
 * It also compares the billed input of each response with the estimate over
 * the request's text (#356): the estimate is fitted to public tokenizers,
 * and Claude's is not public, so the ratio is the only measure of its error
 * on the traffic that passes here.
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
  // Responses whose request text could be estimated: billed input against
  // the estimate, summed, and how many.
  private comparedBilled = 0
  private comparedEstimated = 0
  private compared = 0

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

  observeResponse(requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    const usage = parseUsage(response.body, response.headers)
    if (!usage) return
    this.responses++
    this.input += usage.inputTokens
    this.cacheRead += usage.cacheReadTokens
    this.cacheWrite += usage.cacheWriteTokens
    this.output += usage.outputTokens
    const estimated = estimatedText(requestBody)
    if (estimated !== undefined) {
      this.compared++
      this.comparedEstimated += estimated
      this.comparedBilled += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }
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
        { key: 'estimateRatio', label: 'Billed input per estimated text token', value: this.comparedEstimated > 0 ? (this.comparedBilled / this.comparedEstimated).toFixed(2) : 'n/a' },
        { key: 'compared', label: 'Responses compared', value: this.compared },
      ],
    }
  }

  resetStats(): void {
    this.responses = 0
    this.input = 0
    this.cacheRead = 0
    this.cacheWrite = 0
    this.output = 0
    this.comparedBilled = 0
    this.comparedEstimated = 0
    this.compared = 0
  }
}
