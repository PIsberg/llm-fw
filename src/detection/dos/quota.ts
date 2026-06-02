import { DosConfig } from '../../types.js'

const WINDOW_MS = 60_000
// Default rolling window after which the token budget auto-resets. Keeps a
// long-lived proxy from permanently locking the user out once the lifetime
// total is reached. Overridable via DosConfig.tokenBudgetWindowMs (0 = never).
const DEFAULT_TOKEN_WINDOW_MS = 3_600_000 // 1 hour

/**
 * In-memory sliding-window rate limiter plus a token budget tracker.
 *
 * The RPM limiter keeps an ascending list of request timestamps and rejects a
 * request when admitting it would push the count within the trailing 60s window
 * past `maxRequestsPerMinute`.
 *
 * The token budget accumulates an estimated token count (chars / 4) and trips
 * once it exceeds `maxTokensPerSession`. The budget auto-resets every
 * `tokenBudgetWindowMs` (default 1h) so it behaves as a rolling quota rather
 * than a permanent lockout.
 */
export class QuotaManager {
  private maxRpm: number
  private maxTokens: number
  private tokenWindowMs: number
  private timestamps: number[] = []
  private tokens = 0
  private tokenWindowStart: number | null = null

  constructor(config: DosConfig) {
    this.maxRpm = config.maxRequestsPerMinute
    this.maxTokens = config.maxTokensPerSession
    this.tokenWindowMs = config.tokenBudgetWindowMs ?? DEFAULT_TOKEN_WINDOW_MS
  }

  /**
   * Evict expired timestamps from the FRONT of the (ascending) array instead of
   * re-filtering the whole array on every call. Amortized O(1): each timestamp
   * is removed at most once, and the array never grows past `maxRpm` because we
   * stop recording once the window is full. Bounds event-loop cost even when a
   * rogue agent spams tens of thousands of requests per minute.
   */
  private prune(cutoff: number): void {
    let i = 0
    while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++
    if (i > 0) this.timestamps.splice(0, i)
  }

  /**
   * Record a request at `now` and decide whether it is admitted. When the
   * request would exceed the RPM limit it is NOT recorded and `allowed=false` is
   * returned along with the number of seconds to back off before the oldest
   * in-window request expires.
   */
  checkRpm(now: number = Date.now()): { allowed: boolean; retryAfterSec: number } {
    this.prune(now - WINDOW_MS)

    if (this.timestamps.length >= this.maxRpm) {
      const oldest = this.timestamps[0] ?? now
      const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000))
      return { allowed: false, retryAfterSec }
    }

    this.timestamps.push(now)
    return { allowed: true, retryAfterSec: 0 }
  }

  /** Fast heuristic token estimate: ~4 characters per token. */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  /**
   * Roll the token budget window: once `tokenWindowMs` has elapsed since the
   * window opened, the accumulated count resets automatically. With
   * `tokenWindowMs <= 0` the budget never resets (true lifetime budget).
   */
  private rollTokenWindow(now: number): void {
    if (this.tokenWindowMs <= 0) return
    if (this.tokenWindowStart === null) {
      this.tokenWindowStart = now
      return
    }
    if (now - this.tokenWindowStart >= this.tokenWindowMs) {
      this.tokens = 0
      this.tokenWindowStart = now
    }
  }

  /** Accumulate estimated tokens against the (rolling) budget. */
  addTokens(n: number, now: number = Date.now()): void {
    this.rollTokenWindow(now)
    this.tokens += n
  }

  /** True once the accumulated tokens exceed the configured budget. */
  sessionExceeded(now: number = Date.now()): boolean {
    this.rollTokenWindow(now)
    return this.tokens > this.maxTokens
  }

  tokensUsed(): number {
    return this.tokens
  }

  requestsInWindow(now: number = Date.now()): number {
    this.prune(now - WINDOW_MS)
    return this.timestamps.length
  }

  /** Clear all rate-limit and token state (dashboard "Reset Quota"). */
  reset(): void {
    this.timestamps = []
    this.tokens = 0
    this.tokenWindowStart = null
  }
}
