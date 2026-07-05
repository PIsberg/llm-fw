import { pipeline, env } from '@huggingface/transformers'
import { ResponseScanConfig } from '../types.js'
import { createHash } from 'node:crypto'
import { getLlmFwDir } from '../config/paths.js'
import { join } from 'node:path'

// Trained output-side moderation classifier (Task B5, Option D).
//
// The regex-based harmful-compliance scan (responseHarm.ts) only fires when
// the response matches a hand-written harmful vocabulary AND procedural
// phrasing — precise, but blind to anything outside that vocabulary. This
// stage adds a learned signal over the model's RESPONSE text, mirroring the
// input-side InjectionClassifier (classifier.ts) exactly: lazy ONNX
// text-classification via @huggingface/transformers, opt-in, best-effort.
//
// Model: protectai/distilroberta-base-rejection-v1 (Apache-2.0, DistilRoBERTa
// fine-tuned on LLM outputs, labels NORMAL vs REJECTION). Load-verified
// 2026-07-05 against @huggingface/transformers ^4.2.0: the published
// onnx/model.onnx (~328 MB fp32) downloads and runs with no dtype override.
// Label semantics measured on probe texts: explicit refusals ("I can't help
// you make a pipe bomb…", "I'm sorry, but I can't assist…") score REJECTION
// 0.97–0.9996 while benign answers AND harmful how-to compliance score NORMAL
// ≥ 0.999 — so the flagged label is REJECTION, and the default 0.9 threshold
// separates the classes cleanly.
//
// What that means operationally: this classifier detects the model REFUSING —
// the complement of responseHarm.ts. A refusal in live traffic is strong
// evidence a harmful/jailbreak request slipped past input-side detection and
// only the upstream model's own alignment caught it; surfacing (or, in block
// mode, replacing) that response tells the operator exactly which requests to
// tighten input rules for. Alternatives probed for operators who want
// toxicity-style moderation instead: Xenova/toxic-bert loads fine (set
// responseScan.classifier.model; its non-benign label is scored the same way
// below); martin-ha/toxic-comment-model and unitary/toxic-bert do NOT load
// (no complete ONNX export on the Hub).

// Minimal shape of the @huggingface/transformers text-classification output.
type ClassifyFn = (text: string, opts?: { topk?: number }) => Promise<{ label: string; score: number }[]>

/** HF model id used when responseScan.classifier.model is not configured. */
export const DEFAULT_OUTPUT_CLASSIFIER_MODEL = 'protectai/distilroberta-base-rejection-v1'

// Labels that mean "nothing to report" across the supported/probed models
// (rejection-v1 → NORMAL, toxic-bert → non-toxic variants, generic SAFE/OK).
// Any other top label is treated as the flagged class, so swapping in a
// different binary moderation model via config keeps working.
const BENIGN_LABELS = new Set(['NORMAL', 'SAFE', 'OK', 'BENIGN', 'NON-TOXIC', 'NON_TOXIC', 'NOT_TOXIC'])

export interface OutputClassifierVerdict {
  /** True when the flagged-label probability is at/above the block threshold. */
  flagged: boolean
  /** Probability assigned to the flagged (non-benign) label (0–1). */
  score: number
}

const CACHE_MAX_ENTRIES = 512

export class OutputModerationClassifier {
  private classifier: ClassifyFn | null = null
  private config: ResponseScanConfig | undefined
  private cache = new Map<string, OutputClassifierVerdict>()
  private initAttempted = false

  constructor(config: ResponseScanConfig | undefined) {
    this.config = config
  }

  /** Lazy-load the ONNX model. No-op when the stage is disabled, so the
   *  ~330 MB download only happens for users who opt in. */
  async init(): Promise<void> {
    if (!this.config?.classifier?.enabled || this.initAttempted) return
    this.initAttempted = true
    env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(getLlmFwDir(), 'models')
    env.allowLocalModels = false
    try {
      this.classifier = (await pipeline(
        'text-classification',
        this.config.classifier.model || DEFAULT_OUTPUT_CLASSIFIER_MODEL,
      )) as unknown as ClassifyFn
    } catch (err) {
      // Best-effort, exactly like the input classifier: if the model can't be
      // fetched, leave the stage disabled rather than taking the firewall down.
      this.classifier = null
      console.warn('[output-classifier] could not load response moderation classifier — stage disabled:', (err as Error).message)
    }
  }

  isInitialized(): boolean {
    return this.classifier !== null
  }

  /**
   * Classify a single response text. Returns null when the stage is unavailable
   * (disabled or model failed to load) so the caller can skip it. Results are
   * LRU-cached by content hash — retried/replayed responses skip the model.
   */
  async classify(text: string): Promise<OutputClassifierVerdict | null> {
    if (!this.config?.classifier?.enabled || !text) return null
    // Lazy-load on first use so toggling the stage on from the dashboard
    // activates it without a restart (the first response pays the one-time load).
    if (!this.classifier && !this.initAttempted) await this.init()
    if (!this.classifier) return null
    const threshold = this.config.classifier.blockThreshold ?? 0.9

    const key = createHash('sha256').update(text).digest('hex')
    const cached = this.cache.get(key)
    if (cached) return cached

    try {
      // DistilRoBERTa has a 512-token window; truncate very long responses so a
      // huge generation can't blow up latency or overflow the model.
      const input = text.length > 4000 ? text.slice(0, 4000) : text
      const out = await this.classifier(input)
      const top = out[0]
      const flaggedScore = top && !BENIGN_LABELS.has(top.label.toUpperCase())
        ? top.score
        : (top ? 1 - top.score : 0)
      const verdict: OutputClassifierVerdict = { flagged: flaggedScore >= threshold, score: flaggedScore }

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
