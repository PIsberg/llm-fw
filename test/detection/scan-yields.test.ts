import { describe, it, expect } from 'vitest'
import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

// #464: one large text was scanned in a single synchronous block (candidate
// extraction, then a heuristic pass per whole-text candidate), so every other
// request in the process waited for all of it: 10.6 s for one 2.5 MB text. The
// scan now hands the event loop back between steps. Nothing it computes
// changes, only when other work gets to run.
//
// Embedding is not initialised here, so only the synchronous stages run, which
// is where the stall was. Asserted as a share of the scan, not in seconds, so a
// slow CI runner does not decide the result.

/** Deterministic hex-ish words: the decoders' worst case, and no network or crypto needed. */
function largeText(bytes: number): string {
  let seed = 12345
  const out: string[] = []
  let len = 0
  while (len < bytes) {
    seed = (seed * 1103515245 + 12345) >>> 0
    const w = (seed >>> 4).toString(16).padStart(7, '0').slice(0, 8)
    out.push(w)
    len += w.length + 1
  }
  return out.join(' ')
}

describe('a large text does not hold the event loop for the whole scan', () => {
  it('keeps the longest stall under half of the scan time', async () => {
    const pipeline = new Pipeline(structuredClone(DEFAULT_CONFIG))
    const body = JSON.stringify({ messages: [{ role: 'user', content: largeText(600_000) }] })
    const meta = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages' }

    let last = performance.now()
    let maxGap = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 5)
    const t0 = performance.now()
    await pipeline.run('/v1/messages', body, meta)
    const end = performance.now()
    const total = end - t0
    clearInterval(timer)
    // The gap still open when the scan ends counts too: a loop blocked for the
    // whole scan never runs the timer at all.
    maxGap = Math.max(maxGap, end - last)

    expect(total).toBeGreaterThan(200) // the scan really was heavy enough to measure
    expect(maxGap).toBeLessThan(total / 2)
  }, 120_000)

  it('keeps the longest stall under half of the scan time across many medium texts', async () => {
    // Each 30 KB message is below the per-text threshold, so only yielding at
    // item boundaries keeps forty of them from running back to back.
    const pipeline = new Pipeline(structuredClone(DEFAULT_CONFIG))
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ` + largeText(30_000).slice(i) }))
    messages.push({ role: 'user', content: 'hi' })
    const body = JSON.stringify({ messages })
    const meta = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages' }

    let last = performance.now()
    let maxGap = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 5)
    const t0 = performance.now()
    await pipeline.run('/v1/messages', body, meta)
    const end = performance.now()
    const total = end - t0
    clearInterval(timer)
    maxGap = Math.max(maxGap, end - last)

    expect(total).toBeGreaterThan(200)
    expect(maxGap).toBeLessThan(total / 2)
  }, 120_000)
})
