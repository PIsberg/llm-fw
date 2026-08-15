/**
 * Bounded, visible model loading.
 *
 * Both ML stages fetch their ONNX weights from HuggingFace on first use and
 * already degrade gracefully when that FAILS — the stage is disabled and the
 * rest of the pipeline keeps working (see EmbeddingChecker.init and
 * ClassifierDetector.init). A HANG was a different story: `cli/start.ts`
 * printed "Loading embedding model..." and awaited the load with no timeout,
 * no progress and no bound, so a captive portal, a proxy that black-holes, or
 * HuggingFace rate-limiting left `llm-fw start` waiting forever after a single
 * line of output. The operator cannot tell a slow download from a dead one.
 *
 * This does not introduce a new policy. It routes a hang into the SAME
 * outcome the code already chose for a failure — stage disabled, firewall up,
 * loudly logged — and adds the heartbeat that makes a legitimate slow download
 * distinguishable from a stuck one.
 *
 * The default bound is deliberately generous. These are hundreds of megabytes
 * on a first run, and cutting off a working download to "protect" the operator
 * would silently weaken detection, which is the worse failure for a security
 * product. Tune with `detection.modelLoadTimeoutMs` /
 * `LLM_FW_MODEL_LOAD_TIMEOUT_MS`; 0 disables the bound entirely and restores
 * the old wait-forever behaviour for anyone who wants it.
 */

/** How often to remind the operator that a load is still in flight. */
const HEARTBEAT_MS = 30_000

export class ModelLoadTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(
      `${label} did not finish loading within ${Math.round(ms / 1000)}s. ` +
        `The download may be blocked by a proxy or rate-limited by HuggingFace. ` +
        `Pre-warm a cache with LLM_FW_MODEL_DIR, or raise LLM_FW_MODEL_LOAD_TIMEOUT_MS.`,
    )
    this.name = 'ModelLoadTimeoutError'
  }
}

export interface LoadVisibilityOptions {
  /** Human-readable model name for log lines, e.g. 'embedding model'. */
  label: string
  /** Bound in ms. 0 or negative waits indefinitely. */
  timeoutMs: number
  /** Injected for tests. */
  now?: () => number
  log?: (msg: string) => void
}

/**
 * Run `load`, logging a heartbeat while it is outstanding and rejecting with
 * ModelLoadTimeoutError once `timeoutMs` elapses.
 *
 * The underlying load is NOT cancelled on timeout — transformers.js exposes no
 * abort handle, and a download that later completes still populates the cache
 * so the next start is fast. Only our waiting stops.
 */
export async function loadWithVisibility<T>(
  load: () => Promise<T>,
  opts: LoadVisibilityOptions,
): Promise<T> {
  const log = opts.log ?? ((m: string) => console.warn(m))
  const now = opts.now ?? (() => Date.now())
  const started = now()

  const heartbeat = setInterval(() => {
    const secs = Math.round((now() - started) / 1000)
    log(
      `[llm-fw] still loading ${opts.label} (${secs}s). First run downloads the weights from ` +
        `HuggingFace; set LLM_FW_MODEL_DIR to a persistent path to reuse them across restarts.`,
    )
  }, HEARTBEAT_MS)
  // Never keep the process alive just to print a heartbeat.
  heartbeat.unref?.()

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (!(opts.timeoutMs > 0)) return await load()

    return await Promise.race([
      load(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ModelLoadTimeoutError(opts.label, opts.timeoutMs)), opts.timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearInterval(heartbeat)
    if (timer) clearTimeout(timer)
  }
}
