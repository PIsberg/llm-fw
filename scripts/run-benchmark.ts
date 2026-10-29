/**
 * Independent generalization benchmark.
 *
 * Runs the REAL detection pipeline over held-out datasets that are NOT the
 * tuning corpus, and reports recall (attacks blocked) and false-positive rate
 * (benign blocked) so the "is it state of the art" question is answered with
 * evidence rather than the self-tuned scorecard.
 *
 * Datasets live in test/eval/data/*.json (regenerate the public ones with
 * scripts/fetch-eval-data.ts). They are grouped by `_threat` and reported
 * SEPARATELY — injection, harmful-content, and indirect-injection are
 * different threat models; never average across groups. Rows with
 * `surface: 'tool_result'` are delivered as an Anthropic tool_result block
 * instead of a user prompt.
 *
 * Usage:
 *   node --import tsx/esm scripts/run-benchmark.ts <preset> [model] [--json] [--verbose] [--only=name,...]
 * Presets:
 *   cheap            heuristic + embedding only (judge off) — the default config
 *   judge-suspicious judge on, async-style routing (suspicious-only), sync block
 *   judge-unless     judge on, judgeUnlessBenign, sync block
 *   classifier       cheap + the trained ONNX classifier stage (if integrated)
 *   classifier-indirect  cheap + classifier scoped to tool_result/document only
 *                    (the untrusted surfaces) — the issue #221 indirect-only mode
 * model: Ollama tag for judge presets (default qwen2.5:3b)
 * --json:  print machine-readable results (single JSON object) to stdout
 * --only:  comma-separated dataset names to run (default: all)
 * --isolate / --no-isolate: run each split in its own Node process with an
 *          8 GB heap, or not. Default: isolated for the classifier presets
 *          over more than one split, which otherwise run out of memory (#538)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { Pipeline } from '../src/detection/pipeline.js'
import { anthropicRequestFor, type EvalRow } from '../test/eval/lib/surfaces.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import type { Config } from '../src/types.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const dataDir = join(__dir, '..', 'test', 'eval', 'data')

export type Row = EvalRow
export type Threat = 'injection' | 'harmful-content' | 'indirect-injection'
export interface Dataset { name: string; threat: Threat; revision?: string; rows: Row[] }

/** Load every *.json in the eval data dir that has a labelled `rows` array, so
 *  dropping a new public dataset file in extends the suite automatically.
 *  Exported so other eval runners (e.g. test/eval/competitors/run.ts) reuse
 *  this loader instead of re-implementing dataset discovery. */
export function loadAll(): Dataset[] {
  return readdirSync(dataDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const j = JSON.parse(readFileSync(join(dataDir, f), 'utf8')) as { _source?: string; _threat?: Threat; _revision?: string; rows: Row[] }
      return { name: f.replace('.json', ''), threat: j._threat ?? 'injection', revision: j._revision, rows: j.rows }
    })
    .filter(d => Array.isArray(d.rows) && d.rows.length > 0 && typeof d.rows[0]?.label === 'number')
}

function buildConfig(preset: string, model: string): Config {
  const c: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config
  c.detection.judgeModel = model
  if (preset === 'cheap' || preset === 'classifier' || preset === 'classifier-indirect') {
    c.detection.judgeEnabled = false
  } else if (preset === 'judge-suspicious') {
    c.detection.judgeEnabled = true
    c.detection.judgeBlock = true
    c.detection.judgeUnlessBenign = false
  } else if (preset === 'judge-unless') {
    c.detection.judgeEnabled = true
    c.detection.judgeBlock = true
    c.detection.judgeUnlessBenign = true
  } else {
    throw new Error(`unknown preset: ${preset}`)
  }
  // Classifier stage (optional; only present once integrated).
  const cls = c.detection.classifier
  if (cls) cls.enabled = preset === 'classifier' || preset === 'classifier-indirect'
  // Indirect-only mode: the classifier scans ONLY the untrusted data surfaces,
  // so its (measured, issue #221) false-positive cost on natural user prompts
  // is never paid. DEFAULT_CONFIG's surface list already excludes the trusted
  // system/tool_definition surfaces for the plain 'classifier' preset.
  if (cls && preset === 'classifier-indirect') cls.surfaces = ['tool_result', 'document']
  return c
}

/**
 * Build the request body, delivering each row on the surface it would really
 * arrive on. Shared with the false-positive gate (test/eval/lib/surfaces.ts):
 * the two used to build requests separately and disagreed by 2 blocks on the
 * same corpus, because this one had no case for `system` or `tool_definition`
 * and scanned both as untrusted user text.
 */
const anthropic = (r: Row) => anthropicRequestFor(r, 'toolu_bench')

interface ClassStats { n: number; blocked: number }
interface DsResult {
  tp: number; fn: number; tn: number; fp: number
  recall: number; fpr: number; p50: number
  missed: string[]; falsePos: string[]
  perClass: Record<string, ClassStats>
}

async function evalDataset(pipeline: Pipeline, ds: Dataset): Promise<DsResult> {
  let tp = 0, fn = 0, tn = 0, fp = 0
  const lat: number[] = []
  const missed: string[] = []
  const falsePos: string[] = []
  const perClass: Record<string, ClassStats> = {}
  for (const r of ds.rows) {
    const t0 = performance.now()
    const res = await pipeline.run('/v1/messages', anthropic(r), { target: 'bench', method: 'POST', path: '/v1/messages' })
    lat.push(performance.now() - t0)
    const blocked = res.action === 'block'
    const cls = `${r.label === 1 ? 'attack' : 'benign'}:${r.class ?? '?'}`
    perClass[cls] ??= { n: 0, blocked: 0 }
    const c = perClass[cls]
    c.n++
    if (blocked) c.blocked++
    if (r.label === 1) {
      if (blocked) tp++; else { fn++; missed.push(`[${r.class ?? '?'}] ${r.text.slice(0, 60)}`) }
    } else {
      if (blocked) { fp++; falsePos.push(r.text.slice(0, 60)) } else tn++
    }
  }
  const recall = tp + fn ? tp / (tp + fn) : 0
  const fpr = fp + tn ? fp / (fp + tn) : 0
  lat.sort((a, b) => a - b)
  const p50 = lat[Math.floor(lat.length * 0.5)] ?? 0
  return { tp, fn, tn, fp, recall, fpr, p50, missed, falsePos, perClass }
}

const THREAT_ORDER: Threat[] = ['injection', 'indirect-injection', 'harmful-content']
const THREAT_LABEL: Record<Threat, string> = {
  'injection': 'PROMPT INJECTION (user-prompt surface)',
  'indirect-injection': 'INDIRECT INJECTION (tool_result surface)',
  'harmful-content': 'HARMFUL CONTENT / JAILBREAK REQUESTS (different threat model — do not average with injection)',
}

/** One split's result in the `--json` shape, which an isolated child also prints. */
interface JsonDataset {
  name: string; threat: Threat; revision: string | undefined; n: number
  tp: number; fn: number; tn: number; fp: number
  recall: number; fpr: number | null; p50Ms: number
  perClass: Record<string, { n: number; blocked: number; rate: number }>
  // Row text, only under --verbose: held-out rows must not land in a report
  // unasked (see test/eval/lib/seenRows.ts).
  missed?: string[]; falsePos?: string[]
}

function toJson(ds: Dataset, r: DsResult, verbose: boolean): JsonDataset {
  return {
    name: ds.name,
    threat: ds.threat,
    revision: ds.revision,
    n: ds.rows.length,
    tp: r.tp, fn: r.fn, tn: r.tn, fp: r.fp,
    recall: r.recall,
    fpr: r.fp + r.tn > 0 ? r.fpr : null,
    p50Ms: Math.round(r.p50),
    perClass: Object.fromEntries(Object.entries(r.perClass).map(([k, c]) => [k, { n: c.n, blocked: c.blocked, rate: c.blocked / c.n }])),
    ...(verbose ? { missed: r.missed, falsePos: r.falsePos } : {}),
  }
}

/**
 * Whether each split runs in its own Node process (#538). The classifier
 * presets hold the ONNX classifier beside the embedding model and ran out of
 * memory, silently, part way through the full suite in one process; a fresh
 * process per split with a larger heap finishes. The cheap presets stay in
 * one process, where the model loads once. `--isolate` / `--no-isolate`
 * override; `--child` marks a split's own process, which never spawns again.
 */
export function shouldIsolate(preset: string, argv: readonly string[], datasets: number): boolean {
  if (argv.includes('--child') || argv.includes('--no-isolate')) return false
  if (argv.includes('--isolate')) return datasets > 0
  return preset.startsWith('classifier') && datasets > 1
}

/** Heap for a split's own process: the classifier split OOMed at the default. */
const CHILD_HEAP_MB = 8192

function runChild(preset: string, model: string, name: string, verbose: boolean): JsonDataset {
  const args = [`--max-old-space-size=${CHILD_HEAP_MB}`, '--import', 'tsx/esm', fileURLToPath(import.meta.url),
    preset, model, '--json', '--child', `--only=${name}`, ...(verbose ? ['--verbose'] : [])]
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })
  if (child.status !== 0) {
    throw new Error(`split ${name} failed in its own process (exit ${child.status ?? child.signal}); an OOM shows as a signal or exit 134`)
  }
  const out = JSON.parse(child.stdout) as { datasets: JsonDataset[] }
  const ds = out.datasets[0]
  if (!ds) throw new Error(`split ${name} printed no result`)
  return ds
}

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const preset = positional[0] ?? 'cheap'
  const model = positional[1] ?? 'qwen2.5:3b'
  const verbose = process.argv.includes('--verbose')
  const asJson = process.argv.includes('--json')
  const only = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length).split(',')

  let datasets = loadAll()
  if (only) datasets = datasets.filter(d => only.includes(d.name))
  const isolated = shouldIsolate(preset, process.argv, datasets.length)

  const results: JsonDataset[] = []
  if (isolated) {
    for (const ds of datasets) {
      if (!asJson) process.stderr.write(`running ${ds.name} (n=${ds.rows.length}) in its own process …\n`)
      results.push(runChild(preset, model, ds.name, verbose))
    }
  } else {
    const pipeline = new Pipeline(buildConfig(preset, model))
    await pipeline.init()
    for (const ds of datasets) {
      if (!asJson) process.stderr.write(`running ${ds.name} (n=${ds.rows.length}) …\n`)
      results.push(toJson(ds, await evalDataset(pipeline, ds), verbose))
    }
  }

  if (asJson) {
    console.log(JSON.stringify({
      preset,
      model: preset.startsWith('judge') ? model : undefined,
      isolated,
      datasets: results,
    }, null, 2))
    return
  }

  const modelTag = preset.startsWith('judge') ? ` model='${model}'` : ''
  console.log(`\n=== Benchmark — preset='${preset}'${modelTag} ===`)
  for (const threat of THREAT_ORDER) {
    const group = results.filter(r => r.threat === threat)
    if (!group.length) continue
    console.log(`\n――― ${THREAT_LABEL[threat]} ―――`)
    for (const r of group) {
      const revTag = r.revision ? `  rev=${r.revision.slice(0, 12)}` : ''
      console.log(`\n[${r.name}]  n=${r.n}${revTag}`)
      console.log(`  recall (attacks blocked) : ${(r.recall * 100).toFixed(1)}%  (${r.tp}/${r.tp + r.fn})`)
      console.log(`  FPR    (benign blocked)  : ${r.fpr !== null ? (r.fpr * 100).toFixed(1) + '%  (' + r.fp + '/' + (r.fp + r.tn) + ')' : 'n/a (attacks-only set)'}`)
      console.log(`  p50 latency              : ${r.p50Ms.toFixed(0)} ms`)
      const classes = Object.entries(r.perClass).filter(([k]) => k.split(':')[1] !== '?')
      if (classes.length > 1) {
        console.log('  per class (blocked/n):')
        for (const [k, c] of classes.sort()) console.log(`    ${k.padEnd(40)} ${c.blocked}/${c.n}  (${(c.blocked / c.n * 100).toFixed(0)}%)`)
      }
      if (verbose && r.missed?.length) console.log(`  missed:\n    ${r.missed.slice(0, 20).join('\n    ')}`)
      if (verbose && r.falsePos?.length) console.log(`  false positives:\n    ${r.falsePos.slice(0, 20).join('\n    ')}`)
    }
  }
}

// Only auto-run when this file is the directly-executed entry script — other
// eval runners (e.g. test/eval/competitors/run.ts) import loadAll() from here
// and must NOT trigger a full benchmark sweep as an import side effect.
const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1) })
}
