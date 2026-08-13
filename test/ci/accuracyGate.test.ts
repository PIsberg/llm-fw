import { describe, it, expect } from 'vitest'
import { evaluateGate } from '../load/lib/gate.js'

/**
 * The accuracy gate is the check that keeps the published detection numbers
 * honest, so its own failure modes matter as much as the detector's.
 *
 * The case that motivated these tests actually happened: a sweep in which every
 * request errored reported "✓ All thresholds met" and the scorecard generator
 * then overwrote docs/SCORECARD.md with 0/0 for every attack class. Both rates
 * are 0 when nothing is graded, an FPR of 0 clears any ceiling, and the TPR
 * floor was skipped whenever no attacks had been seen.
 */

const CORPUS = 188
const base = { errCount: 0, planned: CORPUS, fprMax: 2, tprMin: 70 }

describe('accuracy gate — coverage', () => {
  it('fails a run that graded nothing, however clean the rates look', () => {
    const verdict = evaluateGate({ ...base, tn: 0, fp: 0, tp: 0, fn: 0, errCount: CORPUS })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('measured NOTHING')
    // The rates it would have reported are exactly the ones that used to pass.
    expect(verdict.fpr).toBe(0)
    expect(verdict.tpr).toBe(0)
  })

  it('fails a partial run rather than reporting rates from a fraction of the corpus', () => {
    const verdict = evaluateGate({ ...base, tn: 40, fp: 0, tp: 50, fn: 0, errCount: 98 })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('incomplete run')
  })

  it('passes a complete, accurate run', () => {
    const verdict = evaluateGate({ ...base, tn: 78, fp: 0, tp: 110, fn: 0 })
    expect(verdict.passed).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.graded).toBe(CORPUS)
  })
})

describe('accuracy gate — thresholds', () => {
  it('fails when benign traffic is blocked above the ceiling', () => {
    // 4 of 78 benign blocked = 5.1%, over the 2% ceiling.
    const verdict = evaluateGate({ ...base, tn: 74, fp: 4, tp: 110, fn: 0 })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('exceeds ceiling')
  })

  it('fails when recall drops below the floor', () => {
    const verdict = evaluateGate({ ...base, tn: 78, fp: 0, tp: 60, fn: 50 })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('below floor')
  })

  it('applies the recall floor even when the corpus held no attacks', () => {
    // The old gate skipped the floor whenever tp+fn was 0, which is what let a
    // zero-attack run through. Coverage catches it first; the floor also fires.
    const verdict = evaluateGate({ ...base, tn: 78, fp: 0, tp: 0, fn: 0, planned: 78 })
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join(' ')).toContain('below floor')
  })

  it('reports every violation at once, not just the first', () => {
    const verdict = evaluateGate({ ...base, tn: 70, fp: 8, tp: 10, fn: 100 })
    expect(verdict.failures).toHaveLength(2)
  })
})
