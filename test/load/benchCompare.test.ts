import { describe, it, expect } from 'vitest'
import { spread, delta, compareRuns, comparisonMarkdown, type BenchResult, type BenchStep } from './lib/benchCompare.js'

// npm run bench:load:compare puts several benchmark runs per version side by
// side. Two runs of one commit have differed by up to 31%, so these pin the
// rule that a difference is only a change when the runs' ranges do not overlap.

function step(workload: string, concurrency: number, rps: number, p50 = 10): BenchStep {
  return {
    workload, concurrency, throughputRps: rps,
    latency: { p50Ms: p50, p95Ms: p50 * 2, p99Ms: p50 * 3 },
    cpuPct: 100, cpuMsPerRequest: 1000 / rps, peakRssMb: 500, eventLoop: { p99Ms: 20 },
  }
}

function run(commit: string, version: string, rpsAt1: number, rpsAt2: number, extra: Partial<BenchResult> = {}): BenchResult {
  return {
    kind: 'llm-fw-load-benchmark',
    meta: { version, ruleset: 'r', commit, dirty: false, timestamp: `2026-11-14T00:00:${commit.length}`, node: 'v26', cpu: 'cpu', cores: 16 },
    config: { workloads: ['chat'], concurrency: [1, 2], stepS: 10, warmupS: 2, agentKb: 64 },
    startup: { initMs: 1000, processReadyMs: 1500, idle: { rssMb: 400 }, idleAfter: { rssMb: 450 } },
    coldFirstRequestMs: { chat: 100 },
    warnings: [],
    steps: [step('chat', 1, rpsAt1), step('chat', 2, rpsAt2)],
    ...extra,
  }
}

describe('spread', () => {
  it('is the median with the range; an even count takes the mean of the middle two', () => {
    expect(spread([3, 1, 2])).toEqual({ median: 2, min: 1, max: 3, n: 3 })
    expect(spread([10, 40, 20, 30])).toEqual({ median: 25, min: 10, max: 40, n: 4 })
  })

  it('refuses an empty sample rather than inventing a zero', () => {
    expect(() => spread([])).toThrow(/no values/)
  })
})

describe('delta', () => {
  it('calls disjoint ranges a change, in the direction the metric wants', () => {
    expect(delta(spread([40, 42]), spread([50, 52]), 'higher')).toEqual({ pct: 24.39, beyondNoise: true, improved: true })
    // Latency going up is a change for the worse.
    expect(delta(spread([10, 11]), spread([20, 21]), 'lower')).toEqual({ pct: 95.24, beyondNoise: true, improved: false })
  })

  it('calls overlapping ranges noise, however far apart the medians are', () => {
    // Medians 25 apart, but the second run of each overlaps the other's range.
    expect(delta(spread([10, 60]), spread([40, 80]), 'higher')).toEqual({ pct: 71.43, beyondNoise: false })
  })

  it('never calls a single run a change: one sample has no range', () => {
    expect(delta(spread([10]), spread([100]), 'higher').beyondNoise).toBe(false)
    expect(delta(spread([10, 11]), spread([100]), 'higher').beyondNoise).toBe(false)
  })
})

describe('compareRuns', () => {
  it('groups runs by commit in the order given, the first being the baseline', () => {
    const c = compareRuns([run('bbb', '0.9.6', 50, 60), run('aaa', '0.9.4', 40, 45), run('bbb', '0.9.6', 54, 62)])
    expect(c.versions.map(v => [v.label, v.runs])).toEqual([['0.9.6 (bbb)', 2], ['0.9.4 (aaa)', 1]])
    expect(c.steps.chat!['1']!['0.9.6 (bbb)']!.throughputRps).toEqual({ median: 52, min: 50, max: 54, n: 2 })
  })

  it('takes each run\'s own peak before the median, wherever the peak fell', () => {
    // Run one peaks at 1 client, run two at 2: the peaks are 70 and 80.
    const c = compareRuns([run('aaa', '1', 70, 60), run('aaa', '1', 50, 80)])
    expect(c.headline.find(h => h.key === 'chat.peakRps')!.values['1 (aaa)']).toEqual({ median: 75, min: 70, max: 80, n: 2 })
  })

  it('reports a faster version as better only when its runs clear the baseline\'s range', () => {
    const c = compareRuns([run('aaa', 'old', 40, 40), run('aaa', 'old', 42, 42), run('bbb', 'new', 50, 50), run('bbb', 'new', 52, 52)])
    const peak = c.headline.find(h => h.key === 'chat.peakRps')!
    expect(peak.deltas['new (bbb)']).toMatchObject({ beyondNoise: true, improved: true })
    expect(c.notes).toEqual([])
  })

  it('says so when a version has one run', () => {
    const c = compareRuns([run('aaa', 'old', 40, 40), run('bbb', 'new', 50, 50)])
    expect(c.notes.join('\n')).toMatch(/old \(aaa\) has one run/)
    expect(c.headline.find(h => h.key === 'chat.peakRps')!.deltas['new (bbb)']!.beyondNoise).toBe(false)
  })

  it('refuses runs made with different benchmark settings', () => {
    const short = run('bbb', 'new', 50, 50)
    short.config = { ...short.config, stepS: 3 }
    expect(() => compareRuns([run('aaa', 'old', 40, 40), short])).toThrow(/different benchmark settings/)
  })

  it('refuses a file that is not a benchmark result', () => {
    expect(() => compareRuns([{ ...run('aaa', 'old', 1, 1), kind: 'llm-fw-load-comparison' }])).toThrow(/not a load benchmark result/)
  })

  it('uses the labels given for a commit', () => {
    const c = compareRuns([run('aaa', '0.9.4', 1, 1), run('bbb', '0.9.6', 1, 1)], { labels: { bbb: 'main' } })
    expect(c.versions.map(v => v.label)).toEqual(['0.9.4 (aaa)', 'main'])
  })

  it('keeps a run with a detection override apart from the plain runs of the same commit, and names the override', () => {
    // main measured as shipped, and main with spin-waiting switched back on to
    // match a version that spun: one commit, two configurations.
    const spin = { settings: { detection: { embedding: { spinWait: true } }, detectionOverride: { embedding: { spinWait: true } } } }
    const c = compareRuns([
      run('aaa', 'old', 40, 40), run('bbb', 'new', 30, 30), run('bbb', 'new', 31, 31, spin), run('bbb', 'new', 32, 32, spin),
    ], { labels: { bbb: 'main' } })
    expect(c.versions.map(v => [v.label, v.runs, v.override])).toEqual([
      ['old (aaa)', 1, ''], ['main', 1, ''], ['main, embedding.spinWait=true', 2, 'embedding.spinWait=true'],
    ])
    expect(c.steps.chat!['1']!['main']!.throughputRps.median).toBe(30)
    expect(c.steps.chat!['1']!['main, embedding.spinWait=true']!.throughputRps.median).toBe(31.5)
  })

  it('lists the detection settings that differ between versions, and only those', () => {
    const c = compareRuns([
      run('aaa', 'old', 1, 1, { settings: { detection: { workerInference: false, embedding: { spinWait: true, threads: 4 } } } }),
      run('bbb', 'new', 1, 1, { settings: { detection: { workerInference: true, embedding: { spinWait: false, threads: 4 } } } }),
    ])
    expect(c.settingsDiff).toEqual([
      { path: 'embedding.spinWait', values: { 'old (aaa)': true, 'new (bbb)': false } },
      { path: 'workerInference', values: { 'old (aaa)': false, 'new (bbb)': true } },
    ])
  })

  it('notes runs older than the settings field instead of reporting no difference', () => {
    const c = compareRuns([run('aaa', 'old', 1, 1), run('bbb', 'new', 1, 1, { settings: { detection: { workerInference: true } } })])
    expect(c.settingsDiff).toEqual([])
    expect(c.notes.join('\n')).toMatch(/recorded by 1 of 2 versions/)
  })

  it('carries each noisy run\'s warnings into the comparison', () => {
    const c = compareRuns([run('aaa', 'old', 1, 1, { warnings: ['the CPU speed probe varied by 25%'] })])
    expect(c.versions[0]!.warnings).toEqual([expect.stringMatching(/speed probe varied by 25%/)])
  })
})

describe('comparisonMarkdown', () => {
  it('prints medians with ranges and marks each change as better, worse or within noise', () => {
    const md = comparisonMarkdown(compareRuns([
      run('aaa', 'old', 40, 40), run('aaa', 'old', 42, 42), run('bbb', 'new', 50, 50), run('bbb', 'new', 52, 52),
    ]))
    expect(md).toContain('|Peak throughput|41.0 req/s (40.0 req/s-42.0 req/s)|51.0 req/s (50.0 req/s-52.0 req/s), +24.4%, better|')
    // p50 is the same 10 ms in every run: no change, so it reads as noise.
    expect(md).toMatch(/\|p50 at 1 client\|10 ms\|10 ms, 0\.0%, within noise\|/)
  })
})
