/**
 * Nightly benchmark trend tracking + drift gate.
 *
 * Runs `scripts/run-benchmark.ts` (cheap preset, no Ollama / no model download
 * beyond the already-cached embedding model) over a fixed set of held-out
 * splits, appends one row per split to `docs/load-results/bench-trend.jsonl`,
 * and fails (non-zero exit) when the new run regresses vs. the median of the
 * last 7 prior runs for that split — recall dropping more than `recallDropPts`
 * percentage points, or FPR rising more than `fprRisePts` percentage points.
 *
 * The comparison is against the median of runs *preceding* this one — the row
 * being evaluated is never part of its own baseline, otherwise a big drop
 * would partially mask itself in the window that includes it. The file is
 * still appended regardless of pass/fail, because a failing run is a real,
 * valid data point for future medians.
 *
 * appendRun() and checkDrift() are pure (no fs/process access) so the drift
 * logic can be unit-tested with synthetic history — no benchmark run needed.
 *
 * CLI usage:
 *   node --import tsx/esm scripts/bench-trend.ts [--only=heldout,...] \
 *     [--file=docs/load-results/bench-trend.jsonl] \
 *     [--recall-drop-pts=3] [--fpr-rise-pts=1] [--commit=SHA] [--date=ISO]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One recall/FPR measurement for a single split from a single run. */
export interface TrendRow {
  dateFromCI: string
  commit: string
  split: string
  recall: number
  fpr: number | null
}

export interface DriftThresholds {
  /** Percentage points (e.g. 3 = 3%, compared against fractional 0..1 recall). */
  recallDropPts: number
  /** Percentage points (e.g. 1 = 1%, compared against fractional 0..1 FPR). */
  fprRisePts: number
}

export const DEFAULT_THRESHOLDS: DriftThresholds = { recallDropPts: 3, fprRisePts: 1 }

export interface SplitDriftResult {
  split: string
  recall: number
  recallMedian: number | null
  fpr: number | null
  fprMedian: number | null
  recallRegressed: boolean
  fprRegressed: boolean
  /** Number of prior runs the median was computed over (0..7). */
  sampleSize: number
}

export interface DriftResult {
  pass: boolean
  regressedSplits: string[]
  details: SplitDriftResult[]
}

const LOOKBACK_RUNS = 7

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Append newRows to history. Pure — returns a new array, does not mutate
 *  either input. (No dedup: each CI run contributes exactly one row per
 *  split, so ordinary re-runs simply add another data point.) */
export function appendRun(history: TrendRow[], newRows: TrendRow[]): TrendRow[] {
  return [...history, ...newRows]
}

/** Compare `latest` (one or more rows, one per split, from the run under
 *  test) against the median of the last `LOOKBACK_RUNS` entries in `history`
 *  for the same split. `history` must NOT include `latest` — the baseline is
 *  always prior runs only. Splits with fewer than 1 prior run pass trivially
 *  (nothing to regress against); FPR comparison is skipped when either side
 *  is `null` (attacks-only datasets report no FPR). */
export function checkDrift(
  history: TrendRow[],
  latest: TrendRow[],
  thresholds: DriftThresholds = DEFAULT_THRESHOLDS,
): DriftResult {
  const details: SplitDriftResult[] = []
  const regressedSplits: string[] = []

  for (const row of latest) {
    const prior = history.filter(h => h.split === row.split).slice(-LOOKBACK_RUNS)
    const recallMedian = median(prior.map(h => h.recall))
    const fprSamples = prior.map(h => h.fpr).filter((v): v is number => v !== null)
    const fprMedian = fprSamples.length > 0 ? median(fprSamples) : null

    const recallRegressed =
      recallMedian !== null && recallMedian - row.recall > thresholds.recallDropPts / 100
    const fprRegressed =
      fprMedian !== null && row.fpr !== null && row.fpr - fprMedian > thresholds.fprRisePts / 100

    if (recallRegressed || fprRegressed) regressedSplits.push(row.split)
    details.push({
      split: row.split,
      recall: row.recall,
      recallMedian,
      fpr: row.fpr,
      fprMedian,
      recallRegressed,
      fprRegressed,
      sampleSize: prior.length,
    })
  }

  return { pass: regressedSplits.length === 0, regressedSplits, details }
}

// ---------------------------------------------------------------------------
// CLI entry — I/O + process wiring only. Kept out of the pure functions above
// so tests exercise the drift logic directly with synthetic data.
// ---------------------------------------------------------------------------

const DEFAULT_SPLITS = ['heldout', 'safeguard-prompt-injection', 'injecagent']
const DEFAULT_TREND_FILE = 'docs/load-results/bench-trend.jsonl'

function argValue(flag: string): string | undefined {
  return process.argv.find(a => a.startsWith(`--${flag}=`))?.slice(flag.length + 3)
}

function readHistory(path: string): TrendRow[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as TrendRow)
}

function writeHistory(path: string, rows: TrendRow[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const body = rows.map(r => JSON.stringify(r)).join('\n')
  writeFileSync(path, body.length > 0 ? body + '\n' : '')
}

function gitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.stdout.trim() || 'unknown'
}

function renderReport(drift: DriftResult, thresholds: DriftThresholds): string {
  const lines: string[] = []
  lines.push(`Drift gate (tolerance: recall drop >${thresholds.recallDropPts}pts, FPR rise >${thresholds.fprRisePts}pts vs. last-${LOOKBACK_RUNS}-run median)`)
  for (const d of drift.details) {
    const recallPct = (d.recall * 100).toFixed(1)
    const recallMedPct = d.recallMedian !== null ? (d.recallMedian * 100).toFixed(1) + '%' : 'n/a'
    const fprPct = d.fpr !== null ? (d.fpr * 100).toFixed(1) + '%' : 'n/a'
    const fprMedPct = d.fprMedian !== null ? (d.fprMedian * 100).toFixed(1) + '%' : 'n/a'
    const status = d.recallRegressed || d.fprRegressed ? 'REGRESSED' : 'ok'
    lines.push(`  [${status}] ${d.split}: recall ${recallPct}% (median ${recallMedPct}, n=${d.sampleSize})  fpr ${fprPct} (median ${fprMedPct})`)
  }
  lines.push(drift.pass ? 'PASS — no split regressed beyond tolerance.' : `FAIL — regressed: ${drift.regressedSplits.join(', ')}`)
  return lines.join('\n')
}

interface BenchmarkJson {
  datasets: { name: string; recall: number; fpr: number | null }[]
}

function main(): void {
  const only = (argValue('only') ?? DEFAULT_SPLITS.join(',')).split(',').filter(Boolean)
  const trendFile = argValue('file') ?? DEFAULT_TREND_FILE
  const thresholds: DriftThresholds = {
    recallDropPts: Number(argValue('recall-drop-pts') ?? DEFAULT_THRESHOLDS.recallDropPts),
    fprRisePts: Number(argValue('fpr-rise-pts') ?? DEFAULT_THRESHOLDS.fprRisePts),
  }
  const dateFromCI = argValue('date') ?? new Date().toISOString()
  const commit = argValue('commit') ?? gitSha()

  process.stderr.write(`bench-trend: running cheap preset over [${only.join(', ')}]…\n`)
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', 'scripts/run-benchmark.ts', 'cheap', '--json', `--only=${only.join(',')}`],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) {
    process.stderr.write(run.stderr ?? '')
    console.error(`bench-trend: benchmark run failed (exit ${run.status}).`)
    process.exit(run.status ?? 1)
  }

  let parsed: BenchmarkJson
  try {
    parsed = JSON.parse(run.stdout) as BenchmarkJson
  } catch {
    console.error('bench-trend: could not parse benchmark JSON output.')
    console.error(run.stdout)
    process.exit(1)
  }

  const newRows: TrendRow[] = parsed.datasets.map(d => ({
    dateFromCI,
    commit,
    split: d.name,
    recall: d.recall,
    fpr: d.fpr,
  }))

  const history = readHistory(trendFile)
  const drift = checkDrift(history, newRows, thresholds)
  const updated = appendRun(history, newRows)
  writeHistory(trendFile, updated)

  const report = renderReport(drift, thresholds)
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Benchmark trend\n\n\`\`\`\n${report}\n\`\`\`\n`, { flag: 'a' })
  }

  process.exit(drift.pass ? 0 : 1)
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main()
}
