/**
 * Detection scorecard generator.
 *
 * Runs the deterministic accuracy sweep (every corpus entry exactly once,
 * through the real proxy, heuristic+embedding only) and renders the per-class
 * results as a markdown scorecard:
 *
 *   • docs/SCORECARD.md           — always written
 *   • README.md                   — updated between the scorecard markers
 *                                   when --readme is passed
 *   • $GITHUB_STEP_SUMMARY        — appended when running in GitHub Actions
 *
 * Usage:
 *   npm run scorecard             # sweep + docs/SCORECARD.md (+ CI summary)
 *   npm run scorecard -- --readme # also refresh the README section
 *
 * Exit code mirrors the sweep gate (1 on FPR/TPR floor violation), so CI can
 * use this single step as both scorecard publisher and accuracy gate.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface ClassCounts { tp: number; fn: number; tn: number; fp: number }
interface SweepResult {
  timestamp: string
  config: { fprMax: number; tprMin: number }
  results: {
    confusionMatrix: { tn: number; fp: number; tp: number; fn: number }
    perClass: Record<string, ClassCounts>
    fpr: number
    tpr: number
    p50LatencyMs: number
    p95LatencyMs: number
  }
  passed: boolean
}

const README_START = '<!-- scorecard:start -->'
const README_END = '<!-- scorecard:end -->'

function render(data: SweepResult): string {
  const { perClass, confusionMatrix: cm, fpr, tpr, p50LatencyMs, p95LatencyMs } = data.results
  const date = data.timestamp.slice(0, 10)

  const rows = Object.entries(perClass)
    .filter(([cls]) => cls !== 'benign')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, c]) => {
      const total = c.tp + c.fn
      const pct = total > 0 ? ((c.tp / total) * 100).toFixed(0) : '—'
      return `| ${cls} | ${c.tp}/${total} | ${pct}% |`
    })

  const benignTotal = cm.tn + cm.fp
  const attackTotal = cm.tp + cm.fn

  return [
    `Deterministic full sweep over the labelled corpus (${attackTotal} attacks, ${benignTotal} benign` +
    ` prompts incl. security-themed hard negatives) through the real proxy.`,
    `Cheap stages only — **heuristic + embedding, judge off**; enabling the local` +
    ` Ollama judge raises recall further on novel phrasings.`,
    '',
    '| Attack class | Detected | Recall |',
    '|---|---|---|',
    ...rows,
    `| **Overall (TPR)** | **${cm.tp}/${attackTotal}** | **${tpr.toFixed(1)}%** (gate ≥ ${data.config.tprMin}%) |`,
    `| **False positives (FPR)** | **${cm.fp}/${benignTotal}** | **${fpr.toFixed(1)}%** (gate ≤ ${data.config.fprMax}%) |`,
    '',
    `Latency through the full pipeline: p50 ${p50LatencyMs} ms · p95 ${p95LatencyMs} ms.` +
    ` Generated ${date} by \`npm run scorecard\` (gate: ${data.passed ? 'PASSED' : 'FAILED'}).`,
  ].join('\n')
}

function main(): void {
  const updateReadme = process.argv.includes('--readme')
  const outDir = join('docs', 'load-results')
  mkdirSync(outDir, { recursive: true })
  const jsonPath = join(outDir, 'scorecard-accuracy.json')

  const sweep = spawnSync(process.execPath, ['--import', 'tsx/esm', join('test', 'load', 'accuracy.ts')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      LOAD_SWEEP: '1',
      LOAD_VUS: process.env.LOAD_VUS ?? '4',
      LOAD_OUTPUT_FILE: jsonPath,
    },
  })

  let data: SweepResult
  try {
    data = JSON.parse(readFileSync(jsonPath, 'utf8')) as SweepResult
  } catch {
    console.error('gen-scorecard: sweep produced no JSON output — aborting.')
    process.exit(sweep.status ?? 1)
  }

  const table = render(data)
  const doc = `# Detection Scorecard\n\n${table}\n`
  writeFileSync(join('docs', 'SCORECARD.md'), doc)
  console.log(`\nScorecard written → docs/SCORECARD.md`)

  if (updateReadme) {
    const readme = readFileSync('README.md', 'utf8')
    const start = readme.indexOf(README_START)
    const end = readme.indexOf(README_END)
    if (start === -1 || end === -1 || end < start) {
      console.error(`gen-scorecard: README markers not found (${README_START} … ${README_END}).`)
      process.exit(1)
    }
    const updated =
      readme.slice(0, start + README_START.length) + '\n' + table + '\n' + readme.slice(end)
    writeFileSync('README.md', updated)
    console.log('Scorecard section updated → README.md')
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Detection Scorecard\n\n${table}\n`)
  }

  process.exit(sweep.status ?? 0)
}

main()
