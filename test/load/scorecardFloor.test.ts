import { describe, it, expect } from 'vitest'
import { evaluateScorecardFloor, SCORECARD_FLOORS, type ClassCounts } from './lib/scorecardFloor.js'

// The scorecard's own gate is 70% overall, so one attack class could lose a
// row and nothing failed: social-engineering did, at ruleset 2026.10.90, and
// it was found by hand three weeks later (#750). These pin a count per class.
const measured = (): Record<string, ClassCounts> => {
  const out: Record<string, ClassCounts> = {}
  for (const [cls, f] of Object.entries(SCORECARD_FLOORS.attacks)) out[cls] = { tp: f.attacks, fn: 0, tn: 0, fp: 0 }
  out.benign = { tp: 0, fn: 0, tn: SCORECARD_FLOORS.benign.rows, fp: 0 }
  return out
}

describe('the scorecard floor', () => {
  it('passes the counts it was measured on', () => {
    expect(evaluateScorecardFloor(measured()).failures).toEqual([])
  })

  it('fails on one attack lost in one class, and names it', () => {
    const counts = measured()
    counts['social-engineering'] = { tp: 7, fn: 1, tn: 0, fp: 0 }
    expect(evaluateScorecardFloor(counts).failures).toEqual(['social-engineering: detected 7 of 8, floor 8'])
  })

  it('fails on the first benign prompt blocked', () => {
    const counts = measured()
    counts.benign = { tp: 0, fn: 0, tn: SCORECARD_FLOORS.benign.rows - 1, fp: 1 }
    expect(evaluateScorecardFloor(counts).failures).toEqual([`benign: blocked 1 of ${SCORECARD_FLOORS.benign.rows}, ceiling 0`])
  })

  it('fails when a class did not run, and when one has no floor yet', () => {
    const counts = measured()
    delete counts['many-shot']
    counts['brand-new-class'] = { tp: 3, fn: 0, tn: 0, fp: 0 }
    expect(evaluateScorecardFloor(counts).failures).toEqual([
      'many-shot: did not run',
      'brand-new-class: no floor in test/load/lib/scorecardFloor.ts; pin its measured count',
    ])
  })

  it('fails when the corpus changed under a class, so the floor is re-pinned with it', () => {
    const counts = measured()
    counts['multilingual'] = { tp: 11, fn: 0, tn: 0, fp: 0 }
    expect(evaluateScorecardFloor(counts).failures).toEqual(['multilingual: 11 attack rows, the floor was measured on 10'])
  })
})
