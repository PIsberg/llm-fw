/**
 * Competitor guardrail head-to-head runner.
 *
 * Evaluates every adapter in ./index.ts, llm-fw's own presets among them
 * (./llm-fw.ts), against the same splits (scripts/run-benchmark.ts's dataset
 * loader), then writes docs/BENCHMARK-COMPETITORS.md plus a recall-vs-FPR
 * scatter SVG per split. Adapters that can't run here (gated HF repo, no
 * Ollama/model, no API key) are skipped cleanly and listed in the doc's
 * "adapters not run" section — never a hard failure.
 *
 * Memory safety (Task B1's lesson): a single process loading the ONNX
 * classifier and iterating a 2000+-row split died OOM previously, so this
 * script runs EACH split in its own subprocess with an enlarged heap
 * (--max-old-space-size=8192) rather than looping over all splits in one
 * long-lived process.
 *
 * Usage:
 *   node --import tsx/esm test/eval/competitors/run.ts [--only=<split,...>] [--json]
 * --only:  comma-separated dataset names (default: DEFAULT_SPLITS below)
 * --json:  print the aggregated results as JSON instead of writing the docs
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { loadAll } from '../../../scripts/run-benchmark.js'
import { createAdapters } from './index.js'
import { buildMarkdown, buildScatterSvg, scatterPointsForSplit } from './report.js'
import { RULESET_VERSION } from '../../../src/detection/ruleset.js'
import type { SplitResult } from './report.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const THIS_FILE = fileURLToPath(import.meta.url)
const REPO_ROOT = join(__dir, '..', '..', '..')

/**
 * Direct injection first, then indirect, then the benign-only corpora, where
 * a guardrail has nothing to catch and can only be wrong.
 */
const DEFAULT_SPLITS = [
  'safeguard-prompt-injection', 'heldout', 'gandalf-ignore-instructions', 'deepset-prompt-injections',
  'jailbreak-classification', 'multilingual-injections',
  'injecagent', 'indirect-identifier-free',
  'benign-realistic', 'dolly-15k-sample', 'oasst1-sample', 'aya-sample',
]

/** Runs every adapter against a single dataset in-process. Only ever invoked
 *  in --worker mode (i.e. inside the isolated-heap subprocess). */
async function runWorker(datasetName: string): Promise<SplitResult> {
  const ds = loadAll().find(d => d.name === datasetName)
  if (!ds) throw new Error(`unknown dataset: ${datasetName}`)
  const adapters = createAdapters()
  const results: SplitResult['adapters'] = []
  for (const a of adapters) {
    const ok = await a.available()
    if (!ok) {
      results.push({ name: a.name, own: a.own, ran: false, reason: a.skipReason?.() ?? 'not run: unavailable' })
      continue
    }
    let tp = 0, fn = 0, tn = 0, fp = 0
    for (const r of ds.rows) {
      let verdict: { injection: boolean }
      try {
        verdict = await a.classify(r.text, r)
      } catch {
        // A transient adapter error (e.g. a flaky API call) counts as "did
        // not flag" rather than aborting the whole split.
        verdict = { injection: false }
      }
      if (r.label === 1) { if (verdict.injection) tp++; else fn++ }
      else { if (verdict.injection) fp++; else tn++ }
    }
    const recall = tp + fn ? tp / (tp + fn) : null
    const fpr = fp + tn ? fp / (fp + tn) : null
    results.push({ name: a.name, own: a.own, ran: true, n: ds.rows.length, tp, fn, tn, fp, recall, fpr })
    // One guardrail's models at a time: the three llm-fw presets and the
    // standalone classifier would otherwise each hold a copy.
    await a.close?.()
  }
  return { dataset: ds.name, threat: ds.threat, n: ds.rows.length, adapters: results }
}

/** Spawns this same file as a --worker subprocess for one split, with a large
 *  heap ceiling, and reads its JSON result back from a temp file. A temp file
 *  (rather than stdout) survives ONNX runtime / transformers.js printing its
 *  own diagnostic logs to stdout during model load, which would otherwise
 *  corrupt a JSON.parse of the captured stdout stream. */
function runSplitInSubprocess(datasetName: string): SplitResult {
  process.stderr.write(`[bench:competitors] running ${datasetName} in an isolated subprocess …\n`)
  const outFile = join(tmpdir(), `llm-fw-bench-competitors-${randomUUID()}.json`)
  try {
    const res = spawnSync(process.execPath, [
      '--max-old-space-size=8192',
      '--import', 'tsx/esm',
      THIS_FILE,
      `--only=${datasetName}`,
      '--worker',
      `--out=${outFile}`,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 })
    if (res.stdout) process.stderr.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    if (res.status !== 0) {
      throw new Error(`bench:competitors worker for ${datasetName} exited with code ${res.status}`)
    }
    return JSON.parse(readFileSync(outFile, 'utf8')) as SplitResult
  } finally {
    try { rmSync(outFile, { force: true }) } catch { /* best-effort cleanup */ }
  }
}

async function main() {
  const onlyArg = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length)
  const only = onlyArg ? onlyArg.split(',') : DEFAULT_SPLITS
  const isWorker = process.argv.includes('--worker')
  const outArg = process.argv.find(a => a.startsWith('--out='))?.slice('--out='.length)
  const asJson = process.argv.includes('--json')

  if (isWorker) {
    if (only.length !== 1) throw new Error('--worker requires exactly one --only=<split>')
    if (!outArg) throw new Error('--worker requires --out=<path>')
    const result = await runWorker(only[0])
    writeFileSync(outArg, JSON.stringify(result), 'utf8')
    return
  }

  const splits = only.map(runSplitInSubprocess)

  if (asJson) {
    console.log(JSON.stringify({ ruleset: RULESET_VERSION, splits }, null, 2))
    return
  }

  const outDir = join(REPO_ROOT, 'docs', 'competitors-results')
  mkdirSync(outDir, { recursive: true })
  const chartPaths: Record<string, string> = {}
  for (const split of splits) {
    const points = scatterPointsForSplit(split)
    if (!points.length) continue
    const svg = buildScatterSvg(points, `Recall vs FPR — ${split.dataset}`)
    const fileName = `recall-vs-fpr-${split.dataset}.svg`
    writeFileSync(join(outDir, fileName), svg, 'utf8')
    chartPaths[split.dataset] = `competitors-results/${fileName}`
    process.stderr.write(`  wrote docs/competitors-results/${fileName}\n`)
  }

  const md = buildMarkdown({
    splits,
    ruleset: RULESET_VERSION,
    generatedAt: new Date().toISOString().slice(0, 10),
    chartPaths,
  })
  const docPath = join(REPO_ROOT, 'docs', 'BENCHMARK-COMPETITORS.md')
  writeFileSync(docPath, md, 'utf8')
  process.stderr.write(`\nWrote docs/BENCHMARK-COMPETITORS.md\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
