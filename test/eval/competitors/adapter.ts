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
  /** Classify a single text. Only called after available() resolved true. */
  classify(text: string): Promise<{ injection: boolean; score?: number }>
  /**
   * Optional: explains why available() returned false, e.g.
   * "not run: gated model" or "not run: LAKERA_API_KEY not set". The report
   * generator surfaces this verbatim in the "adapters not run" note. Absent
   * or undefined when the adapter ran (or hasn't been probed yet).
   */
  skipReason?(): string | undefined
}
