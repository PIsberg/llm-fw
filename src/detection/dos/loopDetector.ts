import { createHash } from 'node:crypto'

const RING_SIZE = 20
const WINDOW_MS = 10_000
const LOOP_THRESHOLD = 3 // strictly more than 3 (>=4) within the window => loop

interface Entry {
  hash: string
  time: number
}

/**
 * Behavioral loop detector. Keeps a ring buffer of the last ~20 request body
 * hashes and their timestamps. An agent stuck in a recursive loop sends the
 * exact same body repeatedly; when an identical hash has been seen more than
 * three times (>=4) inside a 10s window the circuit is considered tripped.
 */
export class LoopDetector {
  private ring: Entry[] = []

  private static hash(body: string): string {
    return createHash('sha256').update(body).digest('hex')
  }

  /** Record a request body at `now`, evicting the oldest entry past capacity. */
  record(body: string, now: number = Date.now()): void {
    this.ring.push({ hash: LoopDetector.hash(body), time: now })
    if (this.ring.length > RING_SIZE) this.ring.shift()
  }

  /**
   * Drop the most recent record of this body. Called when the upstream rejected
   * the attempt (an error status or no answer): provider SDKs retry exactly
   * that case with the identical body, and a retry of a call that never
   * completed is not an agent going round in circles. Nothing was billed for
   * it either, which is what the circuit breaker exists to bound.
   */
  forget(body: string): void {
    const hash = LoopDetector.hash(body)
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (this.ring[i]!.hash === hash) {
        this.ring.splice(i, 1)
        return
      }
    }
  }

  /**
   * True when the same body hash appears more than three times (counting this
   * occurrence) within the trailing 10s window — i.e. a tight recursive loop.
   */
  isLooping(body: string, now: number = Date.now()): boolean {
    const hash = LoopDetector.hash(body)
    const cutoff = now - WINDOW_MS
    let count = 0
    for (const e of this.ring) {
      if (e.hash === hash && e.time > cutoff) count++
    }
    // +1 for the current (not-yet-recorded) request.
    return count + 1 > LOOP_THRESHOLD
  }

  /** Clear all tracked hashes. */
  reset(): void {
    this.ring = []
  }
}
