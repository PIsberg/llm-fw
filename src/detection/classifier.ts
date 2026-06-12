import { pipeline, env } from '@huggingface/transformers'
import { DetectionConfig } from '../types.js'
import { createHash } from 'node:crypto'
import { getLlmFwDir } from '../config/paths.js'
import { join } from 'node:path'

// Trained prompt-injection classifier stage (a learned generalization layer).
//
// The heuristic + embedding stages are precise but generalize poorly to NOVEL
// phrasings (an independent held-out benchmark put cheap-stage recall at
// ~17-45%). The generative Ollama judge recovers recall but, asked to
// self-classify every prompt, blocks a large fraction of BENIGN traffic
// (measured 27-86% FPR) — unusable. A purpose-built, calibrated binary
// classifier closes the gap far better: it is trained for exactly this label
// and emits well-separated probabilities, so it adds recall on novel attacks
// without the judge's false-positive blow-up.
//
// Model: protectai/deberta-v3-base-prompt-injection-v2 (Apache-2.0, DeBERTa-v3
// fine-tuned for SAFE vs INJECTION). Runs locally via ONNX — no Ollama, no
// network at inference once cached. Opt-in: the weights are ~700 MB, so it is
// disabled by default and downloaded on first use when enabled.

// Minimal shape of the @huggingface/transformers text-classification output.
type ClassifyFn = (text: string, opts?: { topk?: number }) => Promise<{ label: string; score: number }[]>

export interface ClassifierVerdict {
  /** True when the model labels the text INJECTION at/above the block threshold. */
  injection: boolean
  /** Probability assigned to the INJECTION label (0–1). */
  score: number
}

const CACHE_MAX_ENTRIES = 512

export class InjectionClassifier {
  private classifier: ClassifyFn | null = null
  private config: DetectionConfig
  private cache = new Map<string, ClassifierVerdict>()
  private initAttempted = false

  constructor(config: DetectionConfig) {
    this.config = config
  }

  /** Lazy-load the ONNX model. No-op when the classifier stage is disabled, so
   *  the ~700 MB download only happens for users who opt in. */
  async init(): Promise<void> {
    if (!this.config.classifier?.enabled || this.initAttempted) return
    this.initAttempted = true
    env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(getLlmFwDir(), 'models')
    env.allowLocalModels = false
    try {
      // Only an fp32 ONNX export is published for this model, so request it
      // explicitly (the runtime otherwise looks for a quantized variant).
      this.classifier = (await pipeline(
        'text-classification',
        'protectai/deberta-v3-base-prompt-injection-v2',
        { dtype: 'fp32' },
      )) as unknown as ClassifyFn
    } catch (err) {
      // Best-effort, exactly like the embedding stage: if the model can't be
      // fetched, leave the stage disabled rather than taking the firewall down.
      this.classifier = null
      console.warn('[classifier] could not load injection classifier — stage disabled:', (err as Error).message)
    }
  }

  isInitialized(): boolean {
    return this.classifier !== null
  }

  /**
   * Classify a single text. Returns null when the stage is unavailable (disabled
   * or model failed to load) so the caller can skip it. Results are LRU-cached by
   * content hash — proxy traffic re-sends identical system prefixes / tool
   * descriptions constantly, so the cache skips the model for the common case.
   */
  async classify(text: string): Promise<ClassifierVerdict | null> {
    if (!this.config.classifier?.enabled || !text) return null
    // Lazy-load on first use so toggling the stage on from the dashboard
    // activates it without a restart (the first request pays the one-time load).
    if (!this.classifier && !this.initAttempted) await this.init()
    if (!this.classifier) return null
    const threshold = this.config.classifier.blockThreshold ?? 0.9

    const key = createHash('sha256').update(text).digest('hex')
    const cached = this.cache.get(key)
    if (cached) return cached

    try {
      // DeBERTa-v3-base has a 512-token window; truncate very long inputs so a
      // huge tool-result blob can't blow up latency or overflow the model.
      const input = text.length > 4000 ? text.slice(0, 4000) : text
      const out = await this.classifier(input)
      const top = out[0]
      const injScore = top && top.label.toUpperCase() === 'INJECTION'
        ? top.score
        : (top ? 1 - top.score : 0)
      const verdict: ClassifierVerdict = { injection: injScore >= threshold, score: injScore }

      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value
        if (oldest !== undefined) this.cache.delete(oldest)
      }
      this.cache.set(key, verdict)
      return verdict
    } catch {
      return null
    }
  }
}
