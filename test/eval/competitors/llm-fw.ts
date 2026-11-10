import { Pipeline } from '../../../src/detection/pipeline.js'
import { buildConfig } from '../../../scripts/run-benchmark.js'
import { anthropicRequestFor } from '../lib/surfaces.js'
import type { EvalRow } from '../lib/surfaces.js'
import type { CompetitorAdapter } from './adapter.js'

/** The run-benchmark presets the head-to-head measures, with the name each gets in the report. */
export const LLM_FW_PRESETS = {
  cheap: 'llm-fw cheap (default)',
  'classifier-corroborated': 'llm-fw + classifier, corroborated',
  classifier: 'llm-fw + classifier, uncorroborated',
} as const

export type LlmFwPreset = keyof typeof LLM_FW_PRESETS

/**
 * llm-fw itself, as one more guardrail in the head-to-head.
 *
 * The report used to print llm-fw's numbers from a table copied out of
 * docs/BENCHMARK-IMPROVEMENTS.md in July 2026. Nothing re-measured them, so
 * in November it still said the default configuration blocks 43.5% of
 * safeguard and 61.3% of heldout while `npm run recall:floor` measured 76.3%
 * and 74.2% (#533). Running the real pipeline here, on the rows the other
 * guardrails get, is what keeps the two columns comparable.
 *
 * A row is delivered the way run-benchmark delivers it: on its declared
 * surface, inside an Anthropic Messages request. A block is a hit; a warn is
 * not, since a warned request is forwarded.
 */
export class LlmFwAdapter implements CompetitorAdapter {
  readonly name: string
  readonly own = true
  private pipeline: Pipeline | undefined

  constructor(private readonly preset: LlmFwPreset) {
    this.name = LLM_FW_PRESETS[preset]
  }

  async available(): Promise<boolean> {
    if (!this.pipeline) {
      this.pipeline = new Pipeline(buildConfig(this.preset, ''))
      await this.pipeline.init()
    }
    return true
  }

  async classify(text: string, row?: EvalRow): Promise<{ injection: boolean }> {
    if (!this.pipeline) throw new Error('llm-fw adapter: call available() first')
    const body = anthropicRequestFor(row ?? { text, label: 0 })
    const r = await this.pipeline.run('/v1/messages', body, { target: 'eval', method: 'POST', path: '/v1/messages' })
    return { injection: r.action === 'block' }
  }

  async close(): Promise<void> {
    await this.pipeline?.close()
    this.pipeline = undefined
  }
}
