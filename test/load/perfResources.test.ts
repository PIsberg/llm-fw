import { describe, it, expect } from 'vitest'
import { startResourceSampler } from './lib/resources.js'
import { mermaidLine } from './lib/charts.js'
import { appendPerfRow, perfRowFrom, renderPerfTrend, type PerfRow } from '../../scripts/perf-trend.js'

// #598: the performance scenario measures CPU and memory beside latency, draws
// them into the CI job summary, and a nightly job keeps one row per run so a
// version can be compared with the ones before it.
describe('resource sampling', () => {
  it('reports CPU time, peak memory and a per-interval series while work runs', async () => {
    const stop = startResourceSampler(20)
    const junk: number[][] = []
    // Work in short bursts with the event loop free between them, so the
    // sampler's timer fires during the run and not only after it.
    for (let burst = 0; burst < 6; burst++) {
      const until = Date.now() + 20
      while (Date.now() < until) junk.push(Array.from({ length: 1000 }, Math.random))
      await new Promise(r => setTimeout(r, 25))
    }
    const r = stop()
    expect(r.wallMs).toBeGreaterThanOrEqual(150)
    expect(r.cpuMs).toBeGreaterThan(0)
    expect(r.cpuPct).toBeGreaterThan(0)
    expect(r.peakRssMb).toBeGreaterThan(0)
    expect(r.peakHeapMb).toBeGreaterThan(0)
    expect(r.peakRssMb).toBeGreaterThanOrEqual(r.series.reduce((m, s) => Math.max(m, s.rssMb), 0))
    expect(r.series.length).toBeGreaterThanOrEqual(2)
    expect(junk.length).toBeGreaterThan(0)
  })
})

describe('charts for the job summary', () => {
  it('draws one Mermaid line chart with its labels and values', () => {
    const md = mermaidLine('Peak RSS per second', 'MB', ['1', '2', '3'], [210.5, 230, 228.25])
    expect(md).toBe([
      '```mermaid',
      'xychart-beta',
      '  title "Peak RSS per second"',
      '  x-axis ["1", "2", "3"]',
      '  y-axis "MB"',
      '  line [210.5, 230, 228.3]',
      '```',
      '',
    ].join('\n'))
  })

  it('draws nothing for an empty series', () => {
    expect(mermaidLine('t', 'y', [], [])).toBe('')
  })
})

describe('the nightly performance trend', () => {
  const result = {
    scenario: 'performance', timestamp: '2026-11-01T03:00:00Z', passed: true,
    results: { throughputRps: 41.2, latencyPercentiles: { p50: 70, p95: 140, p99: 210 }, resources: { cpuPct: 92.5, peakRssMb: 830.4, peakHeapMb: 210.1 } },
  }

  it('reads one row from a scenario A result', () => {
    expect(perfRowFrom(result, 'abc1234', '2026-11-01T03:10:00Z')).toEqual({
      dateFromCI: '2026-11-01T03:10:00Z', commit: 'abc1234', rps: 41.2, p50Ms: 70, p95Ms: 140, p99Ms: 210, cpuPct: 92.5, peakRssMb: 830.4, peakHeapMb: 210.1, passed: true,
    })
  })

  it('appends to the history as JSONL and keeps what was there', () => {
    const row = perfRowFrom(result, 'abc1234', '2026-11-01T03:10:00Z')
    const next = appendPerfRow('{"commit":"old"}\n', row)
    expect(next.trimEnd().split('\n').map(l => JSON.parse(l).commit)).toEqual(['old', 'abc1234'])
    expect(appendPerfRow('', row).endsWith('\n')).toBe(true)
  })

  it('renders the last runs as charts, oldest first, labelled by commit', () => {
    const rows: PerfRow[] = Array.from({ length: 35 }, (_, i) => ({ dateFromCI: `2026-10-${String(i % 28 + 1).padStart(2, '0')}`, commit: `c${String(i).padStart(6, '0')}`, rps: 40 + i, p50Ms: 70, p95Ms: 140, p99Ms: 200 + i, cpuPct: 90, peakRssMb: 800 + i, peakHeapMb: 200, passed: true }))
    const md = renderPerfTrend(rows, 30)
    expect(md).toContain('## Performance trend, last 30 runs')
    expect(md).toContain('"c000005"')
    expect(md).not.toContain('"c000004"')
    expect((md.match(/```mermaid/g) ?? []).length).toBe(4)
    expect(md).toContain('line [205, 206')
  })
})
