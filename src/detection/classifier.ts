import { pipeline, env } from '@huggingface/transformers'
import { DetectionConfig } from '../types.js'
import { createHash } from 'node:crypto'
import { getLlmFwDir } from '../config/paths.js'
import { join } from 'node:path'
import { getInferenceWorkerClient, InferenceWorkerClient, WorkerUnavailableError } from './inferenceWorker.js'
import { loadWithVisibility } from './modelLoad.js'
import { unwrapClaudeCodeEnvelope, isClaudeCodeNotice, unwrapClaudeCodeReminders } from './clientEnvelopes.js'
import { isWithholdNotice } from './withhold.js'
import { createLogger } from '../logger.js';

const log = createLogger('classifier');

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
export type ClassifyFn = (text: string, opts?: { topk?: number }) => Promise<{ label: string; score: number }[]>

export interface ClassifierVerdict {
  /** True when the model labels the text INJECTION at/above the block threshold. */
  injection: boolean
  /** Probability assigned to the INJECTION label (0–1). */
  score: number
}

const CACHE_MAX_ENTRIES = 512

// Model identity, exported so the worker-thread entry (inferenceWorkerEntry.ts)
// loads the EXACT same model/dtype as the in-process path — see embedding.ts's
// equivalent constants for the same "never let the worker drift" rationale.
export const CLASSIFIER_MODEL_ID = 'protectai/deberta-v3-base-prompt-injection-v2'
export const CLASSIFIER_DTYPE = 'fp32' as const

export async function loadInjectionClassifier(): Promise<ClassifyFn> {
  // Only an fp32 ONNX export is published for this model, so request it
  // explicitly (the runtime otherwise looks for a quantized variant).
  return (await pipeline('text-classification', CLASSIFIER_MODEL_ID, { dtype: CLASSIFIER_DTYPE })) as unknown as ClassifyFn
}

export class InjectionClassifier {
  private classifier: ClassifyFn | null = null
  private config: DetectionConfig
  private cache = new Map<string, ClassifierVerdict>()
  private initAttempted = false
  // Task C3 — mirrors EmbeddingChecker's `ready` flag: true once the worker
  // has confirmed it can classify, decoupled from `classifier` (which stays
  // null in worker mode unless a permanent fallback loads it in-process).
  private workerReady = false
  private readonly workerClient: InferenceWorkerClient

  constructor(config: DetectionConfig, workerClient?: InferenceWorkerClient) {
    this.config = config
    this.workerClient = workerClient ?? getInferenceWorkerClient()
  }

  /** Lazy-load the ONNX model. No-op when the classifier stage is disabled, so
   *  the ~700 MB download only happens for users who opt in. */
  async init(): Promise<void> {
    if (!this.config.classifier?.enabled || this.initAttempted) return
    this.initAttempted = true
    env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(getLlmFwDir(), 'models')
    env.allowLocalModels = false

    if (this.config.workerInference) {
      // Task C3: probe (and lazily load) the model INSIDE the persistent
      // worker thread rather than here. Mirrors the in-process
      // catch-and-disable behaviour below for a genuine load failure; a
      // permanently-disabled worker (crashed twice, possibly from another
      // stage sharing the same worker) instead falls back to loading the
      // model in-process right here.
      try {
        await this.workerClient.ensure('classify')
        this.workerReady = true
      } catch (err) {
        if (err instanceof WorkerUnavailableError) {
          try {
            this.classifier = await loadWithVisibility(loadInjectionClassifier, { label: 'injection classifier', timeoutMs: this.config.modelLoadTimeoutMs ?? 0 })
          } catch (loadErr) {
            this.classifier = null
            log.warn('could not load injection classifier — stage disabled', { err: (loadErr as Error).message })
          }
        } else {
          log.warn('could not load injection classifier — stage disabled', { err: (err as Error).message })
        }
      }
      return
    }

    try {
      this.classifier = await loadWithVisibility(loadInjectionClassifier, { label: 'injection classifier', timeoutMs: this.config.modelLoadTimeoutMs ?? 0 })
    } catch (err) {
      // Best-effort, exactly like the embedding stage: if the model can't be
      // fetched, leave the stage disabled rather than taking the firewall down.
      this.classifier = null
      log.warn('could not load injection classifier — stage disabled', { err: (err as Error).message })
    }
  }

  isInitialized(): boolean {
    return this.config.workerInference ? this.workerReady || this.classifier !== null : this.classifier !== null
  }

  /** The raw single-text forward pass — routes to the worker when enabled,
   *  falling back to loading the model in-process after a permanent worker
   *  failure (second crash). */
  private async classifyRaw(text: string): Promise<{ label: string; score: number }[]> {
    if (this.config.workerInference && this.workerClient.isAvailable()) {
      try {
        return await this.workerClient.classify(text)
      } catch (err) {
        if (!(err instanceof WorkerUnavailableError)) throw err
        // Permanent fallback: load the in-process classifier lazily below.
      }
    }
    if (!this.classifier) this.classifier = await loadWithVisibility(loadInjectionClassifier, { label: 'injection classifier', timeoutMs: this.config.modelLoadTimeoutMs ?? 0 })
    return this.classifier(text)
  }

  /**
   * Classify a single text. Returns null when the stage is unavailable (disabled
   * or model failed to load) so the caller can skip it. Results are LRU-cached by
   * content hash — proxy traffic re-sends identical system prefixes / tool
   * descriptions constantly, so the cache skips the model for the common case.
   * `source` is the surface the text came from and `client` the agent that
   * sent the request, as the sandbox detector names it; see below for what
   * they change.
   */
  async classify(text: string, source?: string, client?: string): Promise<ClassifierVerdict | null> {
    if (!this.config.classifier?.enabled || !text) return null
    // Lazy-load on first use so toggling the stage on from the dashboard
    // activates it without a restart (the first request pays the one-time load).
    if (!this.isInitialized() && !this.initAttempted) await this.init()
    if (!this.isInitialized()) return null
    const threshold = this.config.classifier.blockThreshold ?? 0.9

    // llm-fw's own withhold notices carry nothing anyone wrote, on any surface.
    if (isWithholdNotice(text)) return { injection: false, score: 0 }
    // Claude Code's own envelopes and notices are scored for what they carry
    // (see clientEnvelopes.ts); the model mistakes the wrappers for injection.
    // Only on the surface Claude Code writes each to: envelopes in a user
    // turn, notices as a tool result. Elsewhere someone else wrote them, and
    // the tags are scored with the rest. In a user turn of a request Claude
    // Code sent, its <system-reminder> blocks are read the same way: the
    // harness's own sentences are left out, and what the blocks carry (a
    // CLAUDE.md, a memory file, a block Claude Code did not write) is scored
    // beside the typed text, each on its own; the verdict is the highest. The
    // heuristic and embedding stages still read every sentence; from any
    // other client, so does this one.
    const scored = source === 'prompt' ? unwrapClaudeCodeEnvelope(text) : text
    if (!scored.trim() || (source === 'tool_result' && isClaudeCodeNotice(scored))) return { injection: false, score: 0 }
    const parts = source === 'prompt' && client === 'claude-code' ? unwrapClaudeCodeReminders(scored) : [scored]
    let verdict: ClassifierVerdict = { injection: false, score: 0 }
    for (const part of parts) {
      const v = await this.classifyOne(part, threshold)
      if (v === null) return null
      if (v.score > verdict.score) verdict = v
    }
    return verdict
  }

  /** One text through the cache and the model; null on a model error. */
  private async classifyOne(scored: string, threshold: number): Promise<ClassifierVerdict | null> {
    const key = createHash('sha256').update(scored).digest('hex')
    const cached = this.cache.get(key)
    if (cached) return cached

    try {
      // DeBERTa-v3-base has a 512-token window; truncate very long inputs so a
      // huge tool-result blob can't blow up latency or overflow the model.
      const input = scored.length > 4000 ? scored.slice(0, 4000) : scored
      const out = await this.classifyRaw(input)
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
