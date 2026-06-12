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
 * model: Ollama tag for judge presets (default qwen2.5:3b)
 * --json:  print machine-readable results (single JSON object) to stdout
 * --only:  comma-separated dataset names to run (default: all)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { Pipeline } from '../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import type { Config } from '../src/types.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const dataDir = join(__dir, '..', 'test', 'eval', 'data')

interface Row { text: string; label: number; class?: string; surface?: 'tool_result' }
type Threat = 'injection' | 'harmful-content' | 'indirect-injection'
interface Dataset { name: string; threat: Threat; revision?: string; rows: Row[] }

/** Load every *.json in the eval data dir that has a labelled `rows` array, so
 *  dropping a new public dataset file in extends the suite automatically. */
function loadAll(): Dataset[] {
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
  if (preset === 'cheap' || preset === 'classifier') {
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
  const cls = (c.detection as unknown as { classifier?: { enabled: boolean } }).classifier
  if (cls) cls.enabled = preset === 'classifier'
  return c
}

/** Build the request body. Plain rows go in as a user prompt; rows with
 *  surface 'tool_result' arrive as a tool_result content block, exercising the
 *  pipeline's indirect-injection scan path. */
const anthropic = (r: Row) =>
  r.surface === 'tool_result'
    ? JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bench', content: r.text }] }] })
    : JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: r.text }] })

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
    const c = (perClass[cls] ??= { n: 0, blocked: 0 })
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

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const preset = positional[0] ?? 'cheap'
  const model = positional[1] ?? 'qwen2.5:3b'
  const verbose = process.argv.includes('--verbose')
  const asJson = process.argv.includes('--json')
  const only = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length).split(',')

  const config = buildConfig(preset, model)
  const pipeline = new Pipeline(config)
  await pipeline.init()

  let datasets = loadAll()
  if (only) datasets = datasets.filter(d => only.includes(d.name))

  const results: { ds: Dataset; r: DsResult }[] = []
  for (const ds of datasets) {
    if (!asJson) process.stderr.write(`running ${ds.name} (n=${ds.rows.length}) …\n`)
    results.push({ ds, r: await evalDataset(pipeline, ds) })
  }

  if (asJson) {
    console.log(JSON.stringify({
      preset,
      model: preset.startsWith('judge') ? model : undefined,
      datasets: results.map(({ ds, r }) => ({
        name: ds.name,
        threat: ds.threat,
        revision: ds.revision,
        n: ds.rows.length,
        tp: r.tp, fn: r.fn, tn: r.tn, fp: r.fp,
        recall: r.recall,
        fpr: r.fp + r.tn > 0 ? r.fpr : null,
        p50Ms: Math.round(r.p50),
        perClass: Object.fromEntries(Object.entries(r.perClass).map(([k, c]) => [k, { n: c.n, blocked: c.blocked, rate: c.blocked / c.n }])),
      })),
    }, null, 2))
    return
  }

  console.log(`\n=== Benchmark — preset='${preset}'${preset.startsWith('judge') ? ` model='${model}'` : ''} ===`)
  for (const threat of THREAT_ORDER) {
    const group = results.filter(x => x.ds.threat === threat)
    if (!group.length) continue
    console.log(`\n――― ${THREAT_LABEL[threat]} ―――`)
    for (const { ds, r } of group) {
      const hasBenign = r.fp + r.tn > 0
      console.log(`\n[${ds.name}]  n=${ds.rows.length}${ds.revision ? `  rev=${ds.revision.slice(0, 12)}` : ''}`)
      console.log(`  recall (attacks blocked) : ${(r.recall * 100).toFixed(1)}%  (${r.tp}/${r.tp + r.fn})`)
      console.log(`  FPR    (benign blocked)  : ${hasBenign ? (r.fpr * 100).toFixed(1) + '%  (' + r.fp + '/' + (r.fp + r.tn) + ')' : 'n/a (attacks-only set)'}`)
      console.log(`  p50 latency              : ${r.p50.toFixed(0)} ms`)
      const classes = Object.entries(r.perClass).filter(([k]) => k.split(':')[1] !== '?')
      if (classes.length > 1) {
        console.log('  per class (blocked/n):')
        for (const [k, c] of classes.sort()) console.log(`    ${k.padEnd(40)} ${c.blocked}/${c.n}  (${(c.blocked / c.n * 100).toFixed(0)}%)`)
      }
      if (verbose && r.missed.length) console.log(`  missed:\n    ${r.missed.slice(0, 20).join('\n    ')}`)
      if (verbose && r.falsePos.length) console.log(`  false positives:\n    ${r.falsePos.slice(0, 20).join('\n    ')}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
