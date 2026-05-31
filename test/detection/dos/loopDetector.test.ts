import { describe, it, expect } from 'vitest'
import { LoopDetector } from '../../../src/detection/dos/loopDetector.js'

const BODY = JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'fix the syntax error' }] })
const OTHER = JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'something else entirely' }] })

describe('LoopDetector — exact-match loop detection', () => {
  it('does not flag the first three identical requests within the window', () => {
    const ld = new LoopDetector()
    const t = 1_000_000
    expect(ld.isLooping(BODY, t)).toBe(false)
    ld.record(BODY, t)
    expect(ld.isLooping(BODY, t + 100)).toBe(false)
    ld.record(BODY, t + 100)
    expect(ld.isLooping(BODY, t + 200)).toBe(false)
    ld.record(BODY, t + 200)
  })

  it('flags the 4th identical request within the 10s window', () => {
    const ld = new LoopDetector()
    const t = 1_000_000
    ld.record(BODY, t)
    ld.record(BODY, t + 100)
    ld.record(BODY, t + 200)
    // The 4th occurrence (3 recorded + this one) trips the breaker.
    expect(ld.isLooping(BODY, t + 300)).toBe(true)
  })

  it('does not flag when bodies differ', () => {
    const ld = new LoopDetector()
    const t = 1_000_000
    ld.record(BODY, t)
    ld.record(OTHER, t + 100)
    ld.record(BODY, t + 200)
    ld.record(OTHER, t + 300)
    // Only 2 of each within the window — never reaches the >3 threshold.
    expect(ld.isLooping(BODY, t + 400)).toBe(false)
    expect(ld.isLooping(OTHER, t + 400)).toBe(false)
  })

  it('does not flag when the 4th occurrence falls outside the 10s window', () => {
    const ld = new LoopDetector()
    const t = 1_000_000
    ld.record(BODY, t)
    ld.record(BODY, t + 1000)
    ld.record(BODY, t + 2000)
    // 11s after the first record: the t entry has aged out of the window,
    // leaving only 2 in-window + this one => 3, not >3.
    expect(ld.isLooping(BODY, t + 11_000)).toBe(false)
  })

  it('reset clears tracked hashes', () => {
    const ld = new LoopDetector()
    const t = 1_000_000
    ld.record(BODY, t)
    ld.record(BODY, t + 100)
    ld.record(BODY, t + 200)
    expect(ld.isLooping(BODY, t + 300)).toBe(true)
    ld.reset()
    expect(ld.isLooping(BODY, t + 300)).toBe(false)
  })

  it('defaults now to wall-clock time when omitted', () => {
    const ld = new LoopDetector()
    ld.record(BODY)
    ld.record(BODY)
    ld.record(BODY)
    expect(ld.isLooping(BODY)).toBe(true)
  })
})
