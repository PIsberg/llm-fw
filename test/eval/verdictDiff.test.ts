import { describe, it, expect } from 'vitest'
import { diffVerdicts } from '../../scripts/verdict-diff.js'

/**
 * The row-by-row verdict diff behind every "0 of 23,938 eval verdicts
 * changed" claim (#278, #286, #312). It lived only in session scratch files;
 * now it is a script, and this pins what it counts.
 */
describe('diffVerdicts', () => {
  const a = { 'heldout.json': ['block:heuristic:0.0000', 'pass:none:0.7000', 'pass:none:0.8000'] }

  it('counts block verdicts that flipped, per split', () => {
    const b = { 'heldout.json': ['pass:none:0.0000', 'block:embedding:0.9000', 'pass:none:0.8000'] }
    const d = diffVerdicts(a, b)
    expect(d.changed).toBe(2)
    expect(d.rows).toBe(3)
    expect(d.bySplit).toEqual({ 'heldout.json': 2 })
    expect(d.flips.map(f => [f.split, f.row, f.before, f.after])).toEqual([
      ['heldout.json', 0, 'block', 'pass'],
      ['heldout.json', 1, 'pass', 'block'],
    ])
  })

  it('treats warn and pass alike: only blocking matters to the gates', () => {
    const b = { 'heldout.json': ['block:heuristic:0.0000', 'warn:embedding:0.7000', 'pass:none:0.8000'] }
    expect(diffVerdicts(a, b).changed).toBe(0)
  })

  it('reports similarity drift even when no verdict moves', () => {
    const b = { 'heldout.json': ['block:heuristic:0.0000', 'pass:none:0.7188', 'pass:none:0.8000'] }
    const d = diffVerdicts(a, b)
    expect(d.changed).toBe(0)
    expect(d.maxDrift).toBeCloseTo(0.0188, 4)
  })

  it('refuses dumps of different shape rather than comparing misaligned rows', () => {
    expect(() => diffVerdicts(a, { 'heldout.json': ['block:heuristic:0.0000'] })).toThrow(/row count/)
    expect(() => diffVerdicts(a, {})).toThrow(/missing split/)
  })
})
