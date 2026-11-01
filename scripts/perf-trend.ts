/**
 * Nightly performance trend (#598): one row per run of load scenario A
 * (throughput, latency percentiles, CPU, peak memory), appended to a JSONL
 * history, and the last runs drawn as charts in the job summary so a version
 * can be compared with the ones before it.
 *
 *   node --import tsx/esm scripts/perf-trend.ts --file=perf-trend.jsonl --result=perf.json \
 *     [--commit=SHA] [--date=ISO] [--last=30]
 *
 * The history lives on the orphan branch `perf-trend-data`, fetched and pushed
 * back by .github/workflows/perf-trend.yml, the way the benchmark trend does
 * on `bench-trend-data`. It reports and does not gate: runner noise moves
 * these numbers more than most changes do, and the p99 ceiling in scenario A
 * already fails a run that is slow outright.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mermaidLine } from '../test/load/lib/charts.js'

export interface PerfRow {
  dateFromCI: string
  commit: string
  rps: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  cpuPct: number
  peakRssMb: number
  peakHeapMb: number
  passed: boolean
}

interface ScenarioResult {
  passed: boolean
  results: {
    throughputRps: number
    latencyPercentiles: { p50: number; p95: number; p99: number }
    resources: { cpuPct: number; peakRssMb: number; peakHeapMb: number }
  }
}

/** The trend row for one scenario A result. */
export function perfRowFrom(result: ScenarioResult, commit: string, date: string): PerfRow {
  const r = result.results
  return {
    dateFromCI: date,
    commit,
    rps: r.throughputRps,
    p50Ms: r.latencyPercentiles.p50,
    p95Ms: r.latencyPercentiles.p95,
    p99Ms: r.latencyPercentiles.p99,
    cpuPct: r.resources.cpuPct,
    peakRssMb: r.resources.peakRssMb,
    peakHeapMb: r.resources.peakHeapMb,
    passed: result.passed,
  }
}

/** The history with `row` appended, one JSON object per line. */
export function appendPerfRow(history: string, row: PerfRow): string {
  const base = history && !history.endsWith('\n') ? `${history}\n` : history
  return `${base}${JSON.stringify(row)}\n`
}

/** Markdown with one chart per metric over the last `last` runs, oldest first. */
export function renderPerfTrend(rows: readonly PerfRow[], last = 30): string {
  const tail = rows.slice(-last)
  const labels = tail.map(r => r.commit.slice(0, 7))
  return [
    `## Performance trend, last ${tail.length} runs`,
    '',
    'Load scenario A on the GitHub runner, oldest first, labelled by commit. One process holds the proxy, the mock upstream and the load generator, so compare runs with each other.',
    '',
    mermaidLine('p99 latency', 'ms', labels, tail.map(r => r.p99Ms)),
    mermaidLine('Throughput', 'requests per second', labels, tail.map(r => r.rps)),
    mermaidLine('Peak RSS', 'MB', labels, tail.map(r => r.peakRssMb)),
    mermaidLine('CPU', '% of one core', labels, tail.map(r => r.cpuPct)),
  ].join('\n')
}

function parseRows(text: string): PerfRow[] {
  const rows: PerfRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line) as PerfRow) } catch { /* a torn line */ }
  }
  return rows
}

function main(): void {
  const arg = (k: string): string | undefined => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  const file = resolve(arg('file') ?? 'perf-trend.jsonl')
  const resultFile = arg('result')
  if (!resultFile) {
    console.error('usage: perf-trend --file=<history.jsonl> --result=<scenario A JSON> [--commit=] [--date=] [--last=]')
    process.exit(2)
  }
  const result = JSON.parse(readFileSync(resolve(resultFile), 'utf8')) as ScenarioResult
  const row = perfRowFrom(result, arg('commit') ?? process.env.GITHUB_SHA ?? 'local', arg('date') ?? new Date().toISOString())
  const history = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const next = appendPerfRow(history, row)
  writeFileSync(file, next)
  const md = renderPerfTrend(parseRows(next), Number(arg('last') ?? 30))
  console.log(md)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
