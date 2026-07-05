import { InjectionClassifier } from '../../../src/detection/classifier.js'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'
import type { DetectionConfig } from '../../../src/types.js'
import type { CompetitorAdapter } from './adapter.js'

/**
 * Standalone protectai/deberta-v3-base-prompt-injection-v2 at the model's
 * "natural" 0.5 decision threshold — NOT llm-fw's own operating point (0.9 +
 * the intent-vs-mention gate, see src/detection/classifier.ts /
 * intentMention.ts). This doubles as an ablation baseline: it shows what the
 * same weights do with no calibration or FP-suppression layered on top, so
 * the delta to llm-fw's classifier preset numbers is attributable to our
 * calibration work, not the base model.
 *
 * Reuses the cached classifier loader (classifier.ts) — lazy ONNX load via
 * @huggingface/transformers, ~700 MB, offline once cached under
 * getLlmFwDir()/models.
 */
export class ProtectAiDebertaAdapter implements CompetitorAdapter {
  name: string
  private classifier: InjectionClassifier
  private reason: string | undefined

  constructor(threshold = 0.5) {
    this.name = `protectai/deberta-v3-base-prompt-injection-v2 @${threshold}`
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG.detection)) as DetectionConfig
    cfg.classifier = { enabled: true, blockThreshold: threshold }
    this.classifier = new InjectionClassifier(cfg)
  }

  async available(): Promise<boolean> {
    await this.classifier.init()
    const ok = this.classifier.isInitialized()
    if (!ok) this.reason = 'not run: model failed to load (see console warning above)'
    return ok
  }

  skipReason(): string | undefined {
    return this.reason
  }

  async classify(text: string): Promise<{ injection: boolean; score?: number }> {
    const v = await this.classifier.classify(text)
    if (!v) throw new Error('protectai-deberta: classifier unavailable — call available() first')
    return { injection: v.injection, score: v.score }
  }
}
