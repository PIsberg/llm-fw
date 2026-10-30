import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// #554: the weekly classifier benchmark compares a fresh run with the figures
// docs/BENCHMARK.md publishes, kept as test/eval/baselines/classifier.json.
import { compareRuns, renderComparison, type BenchRun } from '../../scripts/bench-compare.js'

const split = (name: string, tp: number, fn: number, tn: number, fp: number) => ({
  name, n: tp + fn + tn + fp, tp, fn, tn, fp,
  recall: tp + fn ? tp / (tp + fn) : 0,
  fpr: tn + fp ? fp / (tn + fp) : null,
})
const run = (...datasets: ReturnType<typeof split>[]): BenchRun => ({ preset: 'classifier', datasets })

describe('compareRuns', () => {
  it('passes a run inside the tolerance', () => {
    const base = run(split('safeguard', 600, 50, 1408, 2), split('aya', 0, 0, 1635, 1160))
    const now = run(split('safeguard', 595, 55, 1407, 3), split('aya', 0, 0, 1640, 1155))
    const c = compareRuns(base, now)
    expect(c.breaches).toEqual([])
    expect(c.rows.find(r => r.name === 'safeguard' && r.metric === 'recall')?.delta).toBeCloseTo(-5 / 650, 6)
  })

  it('flags recall that moves more than 2 points and FPR more than 1 point, either way', () => {
    const base = run(split('safeguard', 600, 50, 1408, 2), split('oasst1', 0, 0, 1763, 237))
    const now = run(split('safeguard', 580, 70, 1408, 2), split('oasst1', 0, 0, 1700, 300))
    expect(compareRuns(base, now).breaches.map(b => `${b.name}:${b.metric}`)).toEqual(['safeguard:recall', 'oasst1:fpr'])
    // An improvement past the tolerance is a breach too: the published figure is stale.
    const better = run(split('safeguard', 640, 10, 1408, 2), split('oasst1', 0, 0, 1763, 237))
    expect(compareRuns(base, better).breaches.map(b => b.name)).toEqual(['safeguard'])
  })

  it('reports a split whose size changed, or that one run lacks, instead of comparing it', () => {
    const base = run(split('heldout', 26, 5, 20, 1), split('gone', 1, 0, 1, 0))
    const now = run(split('heldout', 27, 5, 20, 1), split('new', 1, 0, 1, 0))
    expect(compareRuns(base, now).breaches.map(b => `${b.name}:${b.metric}`)).toEqual(['heldout:n', 'gone:missing', 'new:missing'])
  })

  it('accepts the committed baseline against itself', () => {
    const baseline = JSON.parse(readFileSync(join(__dirname, 'baselines', 'classifier.json'), 'utf8')) as BenchRun
    expect(baseline.preset).toBe('classifier')
    expect(baseline.datasets.length).toBeGreaterThan(10)
    expect(compareRuns(baseline, baseline).breaches).toEqual([])
  })
})

describe('renderComparison', () => {
  it('prints a markdown table with each breach marked', () => {
    const base = run(split('safeguard', 600, 50, 1408, 2))
    const now = run(split('safeguard', 580, 70, 1408, 2))
    const md = renderComparison(compareRuns(base, now))
    expect(md).toContain('| safeguard | recall | 92.3% | 89.2% | -3.1 **moved** |')
    expect(md).toContain('| safeguard | fpr | 0.1% | 0.1% | +0.0 |')
    expect(md).toMatch(/1 split metric moved past the tolerance/)
  })
})
