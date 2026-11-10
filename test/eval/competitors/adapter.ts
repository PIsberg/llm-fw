/**
 * Shared contract for competitor guardrail adapters (Task B6, Option A).
 *
 * Each adapter wraps a third-party prompt-injection/jailbreak guardrail so the
 * head-to-head report (docs/BENCHMARK-COMPETITORS.md) can compare recall/FPR
 * against llm-fw's own presets on the same held-out splits. Adapters for
 * backends that need credentials, a license acceptance, or a local model pull
 * MUST self-report unavailability via `available()` rather than throwing —
 * the runner treats a `false` return as "skip cleanly", never a failure.
 */
import type { EvalRow } from '../lib/surfaces.js'

export interface CompetitorAdapter {
  /** Human-readable name for the report (model id + notable config, e.g. the
   *  threshold used). */
  name: string
  /**
   * Probe reachability/licensing/config once. Cheap to call repeatedly —
   * implementations should cache the result. Returns false when the adapter
   * cannot run on this machine right now (missing API key, gated HF repo,
   * Ollama unreachable or model not pulled, load failure, ...). Callers MUST
   * NOT call classify() when this returns false.
   */
  available(): Promise<boolean>
  /**
   * True for llm-fw's own presets (./llm-fw.ts), which the report lists first
   * and in bold. They run through this contract like any third-party
   * guardrail, so their numbers come from the same run as everyone else's.
   */
  own?: boolean
  /**
   * Classify a single text. Only called after available() resolved true.
   * `row` is the eval row the text came from: a guardrail that distinguishes
   * a user prompt from a tool result (llm-fw does) reads the surface from it;
   * a standalone classifier ignores it.
   */
  classify(text: string, row?: EvalRow): Promise<{ injection: boolean; score?: number }>
  /** Optional: release models and worker threads once a split is done. */
  close?(): Promise<void>
  /**
   * Optional: explains why available() returned false, e.g.
   * "not run: gated model" or "not run: LAKERA_API_KEY not set". The report
   * generator surfaces this verbatim in the "adapters not run" note. Absent
   * or undefined when the adapter ran (or hasn't been probed yet).
   */
  skipReason?(): string | undefined
}
