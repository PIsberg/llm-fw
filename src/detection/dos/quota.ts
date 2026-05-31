import { DosConfig } from '../../types.js'

const WINDOW_MS = 60_000

/**
 * In-memory sliding-window rate limiter plus a session token budget tracker.
 *
 * The RPM limiter keeps a list of request timestamps, prunes entries older than
 * 60s on every check, and rejects a request when admitting it would push the
 * count within the trailing 60s window past `maxRequestsPerMinute`.
 *
 * The session token budget accumulates an estimated token count (chars / 4) and
 * trips once it exceeds `maxTokensPerSession`.
 */
export class QuotaManager {
  private maxRpm: number
  private maxTokens: number
  private timestamps: number[] = []
  private tokens = 0

  constructor(config: DosConfig) {
    this.maxRpm = config.maxRequestsPerMinute
    this.maxTokens = config.maxTokensPerSession
  }

  /**
   * Record a request at `now` and decide whether it is admitted. Old timestamps
   * (>60s) are pruned first so the window slides. When the request would exceed
   * the RPM limit it is NOT recorded and `allowed=false` is returned along with
   * the number of seconds the caller should back off before the oldest in-window
   * request expires.
   */
  checkRpm(now: number = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const cutoff = now - WINDOW_MS
    this.timestamps = this.timestamps.filter(t => t > cutoff)

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

  /** Accumulate estimated tokens against the session budget. */
  addTokens(n: number): void {
    this.tokens += n
  }

  /** True once the accumulated session tokens exceed the configured budget. */
  sessionExceeded(): boolean {
    return this.tokens > this.maxTokens
  }

  tokensUsed(): number {
    return this.tokens
  }

  requestsInWindow(now: number = Date.now()): number {
    const cutoff = now - WINDOW_MS
    this.timestamps = this.timestamps.filter(t => t > cutoff)
    return this.timestamps.length
  }

  /** Clear all rate-limit and token state (dashboard "Reset Quota"). */
  reset(): void {
    this.timestamps = []
    this.tokens = 0
  }
}
