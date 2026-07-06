import { describe, it, expect } from 'vitest'
import { appendRun, checkDrift, DEFAULT_THRESHOLDS } from '../../scripts/bench-trend.js'
import type { TrendRow } from '../../scripts/bench-trend.js'

/** Build `n` synthetic prior-run rows for one split, dated sequentially. */
function priorRuns(split: string, values: { recall: number; fpr: number | null }[]): TrendRow[] {
  return values.map((v, i) => ({
    dateFromCI: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    commit: `sha${i}`,
    split,
    recall: v.recall,
    fpr: v.fpr,
  }))
}

function latestRow(split: string, recall: number, fpr: number | null): TrendRow {
  return { dateFromCI: '2026-07-01T00:00:00.000Z', commit: 'shaLatest', split, recall, fpr }
}

describe('appendRun', () => {
  it('concatenates without mutating either input', () => {
    const history = priorRuns('heldout', [{ recall: 0.9, fpr: 0.1 }])
    const newRows = [latestRow('heldout', 0.9, 0.1)]
    const historyCopy = [...history]
    const result = appendRun(history, newRows)
    expect(result).toEqual([...history, ...newRows])
    expect(history).toEqual(historyCopy) // unmutated
    expect(result).toHaveLength(2)
  })

  it('returns a fresh array when history is empty', () => {
    const newRows = [latestRow('heldout', 0.9, 0.1)]
    expect(appendRun([], newRows)).toEqual(newRows)
  })
})

describe('checkDrift — recall', () => {
  it('fails when recall drops more than the tolerance vs. the last-7-run median', () => {
    // Median of 7 priors = 0.90. Latest = 0.85 -> drop of 5pts > 3pts tolerance.
    const history = priorRuns('heldout', Array(7).fill({ recall: 0.90, fpr: 0.05 }))
    const latest = [latestRow('heldout', 0.85, 0.05)]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.pass).toBe(false)
    expect(result.regressedSplits).toEqual(['heldout'])
    expect(result.details[0].recallRegressed).toBe(true)
  })

  it('passes when recall drop is within tolerance', () => {
    // Median 0.90, latest 0.88 -> 2pt drop, under the 3pt tolerance.
    const history = priorRuns('heldout', Array(7).fill({ recall: 0.90, fpr: 0.05 }))
    const latest = [latestRow('heldout', 0.88, 0.05)]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.pass).toBe(true)
    expect(result.regressedSplits).toEqual([])
    expect(result.details[0].recallRegressed).toBe(false)
  })

  it('passes when recall improves', () => {
    const history = priorRuns('heldout', Array(7).fill({ recall: 0.80, fpr: 0.05 }))
    const latest = [latestRow('heldout', 0.95, 0.05)]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.pass).toBe(true)
  })
})

describe('checkDrift — fpr', () => {
  it('fails when fpr rises more than the tolerance vs. the median', () => {
    // Median fpr 0.02, latest 0.04 -> 2pt rise > 1pt tolerance.
    const history = priorRuns('safeguard-prompt-injection', Array(7).fill({ recall: 0.85, fpr: 0.02 }))
    const latest = [latestRow('safeguard-prompt-injection', 0.85, 0.04)]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.pass).toBe(false)
    expect(result.details[0].fprRegressed).toBe(true)
    expect(result.details[0].recallRegressed).toBe(false)
  })

  it('passes when fpr rise is within tolerance', () => {
    // Median 0.02, latest 0.025 -> 0.5pt rise, under the 1pt tolerance.
    const history = priorRuns('safeguard-prompt-injection', Array(7).fill({ recall: 0.85, fpr: 0.02 }))
    const latest = [latestRow('safeguard-prompt-injection', 0.85, 0.025)]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.pass).toBe(true)
  })

  it('skips the fpr comparison for attacks-only datasets (fpr null on both sides)', () => {
    const history = priorRuns('injecagent', Array(7).fill({ recall: 0.95, fpr: null }))
    const latest = [latestRow('injecagent', 0.95, null)]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.pass).toBe(true)
    expect(result.details[0].fprMedian).toBeNull()
    expect(result.details[0].fprRegressed).toBe(false)
  })
})

describe('checkDrift — fewer than 7 prior runs', () => {
  it('computes the median over whatever history is available (< 7 runs)', () => {
    // Only 2 priors: 0.80 and 0.90 -> median 0.85. Latest 0.80 -> 5pt drop, fails.
    const history = priorRuns('heldout', [{ recall: 0.80, fpr: 0.05 }, { recall: 0.90, fpr: 0.05 }])
    const latest = [latestRow('heldout', 0.80, 0.05)]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.details[0].sampleSize).toBe(2)
    expect(result.details[0].recallMedian).toBeCloseTo(0.85)
    expect(result.pass).toBe(false)
  })

  it('passes trivially with zero prior runs for a brand-new split', () => {
    const result = checkDrift([], [latestRow('new-split', 0.5, 0.5)], DEFAULT_THRESHOLDS)
    expect(result.pass).toBe(true)
    expect(result.details[0].recallMedian).toBeNull()
    expect(result.details[0].sampleSize).toBe(0)
  })

  it('only considers the last 7 of more than 7 prior runs', () => {
    // 8 priors: one very low outlier (0.50) that should fall out of the window,
    // then 7 identical 0.90 runs. Median of the last 7 = 0.90, so a 0.85 latest
    // (5pt drop from 0.90) fails — if the stale 0.50 outlier were included the
    // median would be lower and might mask the regression.
    const history = [
      ...priorRuns('heldout', [{ recall: 0.50, fpr: 0.05 }]),
      ...priorRuns('heldout', Array(7).fill({ recall: 0.90, fpr: 0.05 })),
    ]
    const latest = [latestRow('heldout', 0.85, 0.05)]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.details[0].sampleSize).toBe(7)
    expect(result.details[0].recallMedian).toBeCloseTo(0.90)
    expect(result.pass).toBe(false)
  })
})

describe('checkDrift — per-split isolation', () => {
  it('a regression on one split does not affect another split in the same run', () => {
    const history = [
      ...priorRuns('heldout', Array(7).fill({ recall: 0.90, fpr: 0.05 })),
      ...priorRuns('injecagent', Array(7).fill({ recall: 0.95, fpr: null })),
    ]
    const latest = [
      latestRow('heldout', 0.80, 0.05), // 10pt drop -> regressed
      latestRow('injecagent', 0.96, null), // improved -> fine
    ]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.pass).toBe(false)
    expect(result.regressedSplits).toEqual(['heldout'])
    const injecagent = result.details.find(d => d.split === 'injecagent')
    expect(injecagent?.recallRegressed).toBe(false)
    const heldout = result.details.find(d => d.split === 'heldout')
    expect(heldout?.recallRegressed).toBe(true)
  })

  it('history rows from other splits never leak into a split\'s median', () => {
    const history = [
      ...priorRuns('heldout', Array(7).fill({ recall: 0.10, fpr: 0.5 })), // deliberately bad, different split
      ...priorRuns('safeguard-prompt-injection', Array(7).fill({ recall: 0.90, fpr: 0.02 })),
    ]
    const latest = [latestRow('safeguard-prompt-injection', 0.89, 0.02)]
    const result = checkDrift(history, latest, DEFAULT_THRESHOLDS)
    expect(result.details[0].recallMedian).toBeCloseTo(0.90)
    expect(result.pass).toBe(true)
  })
})
