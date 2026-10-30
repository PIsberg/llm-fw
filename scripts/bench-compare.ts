/**
 * Compare a fresh `scripts/run-benchmark.ts <preset> --json` run with a
 * committed baseline (#554). The classifier column of docs/BENCHMARK.md was
 * refreshed by hand and drifted for months; the weekly workflow
 * (.github/workflows/classifier-benchmark.yml) re-measures it and runs this.
 *
 * A split metric that moves past the tolerance either way is a breach: worse
 * is a regression, better means the published figure is stale. A split whose
 * size changed, or that one run lacks, is reported rather than compared.
 *
 * Usage:
 *   node --import tsx/esm scripts/bench-compare.ts <baseline.json> <current.json>
 * Prints a markdown table, appends it to $GITHUB_STEP_SUMMARY when set, and
 * exits 1 on any breach.
 */
import { readFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface BenchSplit { name: string; n: number; tp: number; fn: number; tn: number; fp: number; recall: number; fpr: number | null }
export interface BenchRun { preset: string; datasets: BenchSplit[] }

/** Points (fractions) a metric may move before it is a breach. */
export const TOLERANCE = { recall: 0.02, fpr: 0.01 } as const

export interface ComparisonRow {
  name: string
  metric: 'recall' | 'fpr' | 'n' | 'missing'
  base: number | null
  now: number | null
  delta: number | null
  breach: boolean
}
export interface Comparison { preset: string; rows: ComparisonRow[]; breaches: ComparisonRow[] }

export function compareRuns(baseline: BenchRun, current: BenchRun): Comparison {
  const rows: ComparisonRow[] = []
  const now = new Map(current.datasets.map(d => [d.name, d]))
  const seen = new Set<string>()
  for (const b of baseline.datasets) {
    const c = now.get(b.name)
    seen.add(b.name)
    if (!c) { rows.push({ name: b.name, metric: 'missing', base: b.n, now: null, delta: null, breach: true }); continue }
    if (b.n !== c.n) { rows.push({ name: b.name, metric: 'n', base: b.n, now: c.n, delta: c.n - b.n, breach: true }); continue }
    if (b.tp + b.fn > 0) {
      const delta = c.recall - b.recall
      rows.push({ name: b.name, metric: 'recall', base: b.recall, now: c.recall, delta, breach: Math.abs(delta) > TOLERANCE.recall + 1e-9 })
    }
    if (b.fpr !== null && c.fpr !== null) {
      const delta = c.fpr - b.fpr
      rows.push({ name: b.name, metric: 'fpr', base: b.fpr, now: c.fpr, delta, breach: Math.abs(delta) > TOLERANCE.fpr + 1e-9 })
    }
  }
  for (const c of current.datasets) {
    if (!seen.has(c.name)) rows.push({ name: c.name, metric: 'missing', base: null, now: c.n, delta: null, breach: true })
  }
  return { preset: current.preset, rows, breaches: rows.filter(r => r.breach) }
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`)
const pts = (v: number | null) => (v === null ? '' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`)

export function renderComparison(c: Comparison): string {
  const lines = [
    `### Benchmark against the published figures (preset \`${c.preset}\`)`,
    '',
    `Tolerance: recall ${TOLERANCE.recall * 100} points, FPR ${TOLERANCE.fpr * 100} point, either way.`,
    '',
    '| Split | Metric | Published | Now | Delta (points) |',
    '| --- | --- | ---: | ---: | ---: |',
  ]
  for (const r of c.rows) {
    const mark = r.breach ? ' **moved**' : ''
    if (r.metric === 'n') lines.push(`| ${r.name} | rows | ${r.base} | ${r.now} | changed${mark} |`)
    else if (r.metric === 'missing') lines.push(`| ${r.name} | split | ${r.base ?? 'absent'} | ${r.now ?? 'absent'} | only in one run${mark} |`)
    else lines.push(`| ${r.name} | ${r.metric} | ${pct(r.base)} | ${pct(r.now)} | ${pts(r.delta)}${mark} |`)
  }
  lines.push('')
  const n = c.breaches.length
  lines.push(n === 0
    ? 'Every split is within the tolerance of the published figures.'
    : `${n} split metric${n === 1 ? '' : 's'} moved past the tolerance: re-measure and update docs/BENCHMARK.md and test/eval/baselines/, or find the regression.`)
  return lines.join('\n')
}

function main(): void {
  const [baselinePath, currentPath] = process.argv.slice(2)
  if (!baselinePath || !currentPath) {
    console.error('usage: bench-compare.ts <baseline.json> <current.json>')
    process.exit(2)
  }
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as BenchRun
  const comparison = compareRuns(read(baselinePath), read(currentPath))
  const md = renderComparison(comparison)
  console.log(md)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
  if (comparison.breaches.length) process.exit(1)
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
