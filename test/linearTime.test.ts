import { describe, it, expect } from 'vitest'
import { underMs } from './linearTime.js'

// A work function whose first `slowRuns` calls take at least `slowMs`, as a
// load burst on the machine does, and whose later calls are instant.
function burst(slowRuns: number, slowMs: number) {
  let calls = 0
  const work = () => {
    calls++
    if (calls > slowRuns) return
    const until = performance.now() + slowMs
    while (performance.now() < until) { /* busy, like a scan */ }
  }
  return { work, calls: () => calls }
}

describe('underMs (#754)', () => {
  it('stops at the first run under the ceiling', () => {
    const b = burst(0, 0)
    expect(underMs(50, b.work)).toBeLessThan(50)
    expect(b.calls()).toBe(1)
  })

  it('outlasts a burst longer than three runs, which fastest-of-three did not', () => {
    const b = burst(4, 30)
    expect(underMs(20, b.work)).toBeLessThan(20)
    expect(b.calls()).toBe(5)
  })

  it('reports a run that is slow every time as over the ceiling, after every try', () => {
    const b = burst(Number.POSITIVE_INFINITY, 15)
    expect(underMs(10, b.work, 6)).toBeGreaterThanOrEqual(10)
    expect(b.calls()).toBe(6)
  })
})
