import { pipeline, env } from '@huggingface/transformers'
import { getLlmFwDir } from '../../../src/config/paths.js'
import { join } from 'node:path'
import type { CompetitorAdapter } from './adapter.js'

// Minimal shape of the @huggingface/transformers text-classification output.
type ClassifyFn = (text: string) => Promise<{ label: string; score: number }[]>

const MODEL_ID = 'meta-llama/Prompt-Guard-86M'

/**
 * Meta Prompt Guard 86M via transformers.js.
 *
 * NOTE: meta-llama/Prompt-Guard-86M is a GATED Hugging Face repo — an
 * operator must accept Meta's license on huggingface.co and authenticate
 * (huggingface-cli login / HF_TOKEN) before the download succeeds. This
 * adapter attempts the load once, exactly like classifier.ts's lazy-load
 * pattern, and degrades to "not run: gated model" on a 401/403 rather than
 * failing the whole benchmark run.
 */
export class PromptGuardAdapter implements CompetitorAdapter {
  name = MODEL_ID
  private classifier: ClassifyFn | null = null
  private attempted = false
  private reason: string | undefined

  async available(): Promise<boolean> {
    if (!this.attempted) await this.init()
    return this.classifier !== null
  }

  skipReason(): string | undefined {
    return this.reason
  }

  private async init(): Promise<void> {
    this.attempted = true
    env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(getLlmFwDir(), 'models')
    env.allowLocalModels = false
    try {
      this.classifier = (await pipeline('text-classification', MODEL_ID)) as unknown as ClassifyFn
    } catch (err) {
      this.classifier = null
      const msg = (err as Error).message ?? String(err)
      this.reason = /401|403|unauthorized|gated|restricted|access to (model|file)/i.test(msg)
        ? 'not run: gated model (accept the Meta license at huggingface.co and set HF_TOKEN)'
        : `not run: model failed to load (${msg.slice(0, 160)})`
      console.warn('[competitors/prompt-guard] could not load Prompt Guard — stage skipped:', this.reason)
    }
  }

  async classify(text: string): Promise<{ injection: boolean; score?: number }> {
    if (!this.classifier) throw new Error('prompt-guard: not available — call available() first')
    // 512-token window like the other transformer stages; truncate long inputs.
    const input = text.length > 4000 ? text.slice(0, 4000) : text
    const out = await this.classifier(input)
    const top = out[0]
    // Prompt Guard labels: BENIGN, INJECTION, JAILBREAK — anything non-benign flags.
    const injection = !!top && top.label.toUpperCase() !== 'BENIGN'
    return { injection, score: top?.score }
  }
}
