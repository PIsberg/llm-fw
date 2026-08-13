import { describe, it, expect } from 'vitest'
import { wilsonInterval, sampleNeededFor } from './lib/wilson.js'
import { evaluateFprGate } from './lib/fprGate.js'

/**
 * The false-positive gate is the instrument that keeps llm-fw honest about the
 * failure mode that actually loses users: blocking legitimate traffic. Its own
 * arithmetic and its own failure modes therefore get pinned here.
 */

describe('wilsonInterval', () => {
  it('does not claim certainty from a clean small sample', () => {
    // The historical claim: "0% FPR" from 17 benign rows. The normal
    // approximation gives [0, 0] — perfect confidence from no evidence.
    const interval = wilsonInterval(0, 17)
    expect(interval.point).toBe(0)
    expect(interval.upper).toBeGreaterThan(0.15)
    expect(interval.upper).toBeLessThan(0.20)
  })

  it('tightens as the sample grows, with the point estimate unchanged', () => {
    const small = wilsonInterval(0, 21)
    const large = wilsonInterval(0, 4000)
    expect(small.point).toBe(large.point)
    expect(large.upper).toBeLessThan(small.upper / 50)
  })

  it('brackets the observed proportion', () => {
    const interval = wilsonInterval(19, 142)
    expect(interval.point).toBeCloseTo(0.1338, 4)
    expect(interval.lower).toBeLessThan(interval.point)
    expect(interval.upper).toBeGreaterThan(interval.point)
  })

  it('never leaves [0, 1] even at the extremes', () => {
    for (const [f, n] of [[0, 1], [1, 1], [0, 3], [3, 3]]) {
      const interval = wilsonInterval(f!, n!)
      expect(interval.lower).toBeGreaterThanOrEqual(0)
      expect(interval.upper).toBeLessThanOrEqual(1)
    }
  })

  it('treats no observations as no knowledge, not as success', () => {
    const interval = wilsonInterval(0, 0)
    expect(interval.lower).toBe(0)
    expect(interval.upper).toBe(1)
  })
})

describe('sampleNeededFor', () => {
  it('reports the sample a clean run would need to support the claim', () => {
    // A 0.1% claim needs thousands of benign rows; the corpus has 142, and
    // printing this is what stops "0 blocked" being read as "0.1% achieved".
    expect(sampleNeededFor(0.001)).toBeGreaterThan(3000)
    expect(sampleNeededFor(0.15)).toBeLessThan(30)
  })

  it('is unsatisfiable for a zero SLO', () => {
    expect(sampleNeededFor(0)).toBe(Infinity)
  })
})

describe('evaluateFprGate', () => {
  const ceilings = { 'instruction-management': 5, 'rag-document': 3 }
  const clean = {
    'security-qa': { n: 14, blocked: 0 },
    'code-review': { n: 10, blocked: 0 },
  }

  it('passes a run inside the SLO and every ceiling', () => {
    const verdict = evaluateFprGate({
      perClass: { ...clean, 'instruction-management': { n: 10, blocked: 5 } },
      blocked: 5, scanned: 34, expected: 34, sloPct: 15, ceilings,
    })
    expect(verdict.passed).toBe(true)
  })

  it('fails the first false positive in a category with no known ones', () => {
    // The point of per-category ceilings: this would vanish inside an overall
    // percentage, because 1/34 is well under a 15% SLO.
    const verdict = evaluateFprGate({
      perClass: { ...clean, 'security-qa': { n: 14, blocked: 1 } },
      blocked: 1, scanned: 24, expected: 24, sloPct: 15, ceilings,
    })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain("category 'security-qa'")
    expect(verdict.failures.join(' ')).toContain('regression')
  })

  it('fails a category that drifts past its recorded ceiling', () => {
    const verdict = evaluateFprGate({
      perClass: { 'instruction-management': { n: 10, blocked: 7 } },
      blocked: 7, scanned: 10, expected: 10, sloPct: 100, ceilings,
    })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('ceiling 5')
  })

  it('fails on the overall SLO even when every category is within its ceiling', () => {
    const verdict = evaluateFprGate({
      perClass: { 'instruction-management': { n: 10, blocked: 5 }, 'rag-document': { n: 8, blocked: 3 } },
      blocked: 8, scanned: 18, expected: 18, sloPct: 15, ceilings,
    })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('exceeds the SLO')
  })

  it('fails a run that scanned nothing, however clean the rate looks', () => {
    const verdict = evaluateFprGate({
      perClass: {}, blocked: 0, scanned: 0, expected: 142, sloPct: 15, ceilings,
    })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('measured NOTHING')
  })

  it('fails a partial run rather than reporting a rate from part of the corpus', () => {
    const verdict = evaluateFprGate({
      perClass: clean, blocked: 0, scanned: 24, expected: 142, sloPct: 15, ceilings,
    })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('incomplete run')
  })

  it('reports, without failing, a ceiling that detection has outgrown', () => {
    const verdict = evaluateFprGate({
      perClass: { 'instruction-management': { n: 10, blocked: 2 } },
      // sloPct high enough that only the ceiling logic is under test here;
      // 2/10 is 20%, which would otherwise trip the overall SLO.
      blocked: 2, scanned: 10, expected: 10, sloPct: 100, ceilings,
    })
    expect(verdict.passed).toBe(true)
    expect(verdict.improved).toContain('instruction-management')
  })
})
