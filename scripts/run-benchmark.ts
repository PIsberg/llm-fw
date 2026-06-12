/**
 * Independent generalization benchmark.
 *
 * Runs the REAL detection pipeline over two held-out datasets that are NOT the
 * tuning corpus, and reports recall (attacks blocked) and false-positive rate
 * (benign blocked) so the "is it state of the art" question is answered with
 * evidence rather than the self-tuned scorecard.
 *
 *   • test/eval/data/deepset-prompt-injections.json — independent public set
 *   • test/eval/data/heldout.json                   — novel phrasings (harder)
 *
 * Usage:
 *   node --import tsx/esm scripts/run-benchmark.ts <preset> [model]
 * Presets:
 *   cheap            heuristic + embedding only (judge off) — the default config
 *   judge-suspicious judge on, async-style routing (suspicious-only), sync block
 *   judge-unless     judge on, judgeUnlessBenign, sync block
 *   classifier       cheap + the trained ONNX classifier stage (if integrated)
 * model: Ollama tag for judge presets (default qwen2.5:3b)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { Pipeline } from '../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import type { Config } from '../src/types.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const dataDir = join(__dir, '..', 'test', 'eval', 'data')

interface Row { text: string; label: number; class?: string }
interface Dataset { name: string; rows: Row[] }

function load(file: string, name: string): Dataset {
  const j = JSON.parse(readFileSync(join(dataDir, file), 'utf8')) as { rows: Row[] }
  return { name, rows: j.rows }
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

const anthropic = (text: string) =>
  JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: text }] })

async function evalDataset(pipeline: Pipeline, ds: Dataset) {
  let tp = 0, fn = 0, tn = 0, fp = 0
  const lat: number[] = []
  const missed: string[] = []
  const falsePos: string[] = []
  for (const r of ds.rows) {
    const t0 = performance.now()
    const res = await pipeline.run('/v1/messages', anthropic(r.text), { target: 'bench', method: 'POST', path: '/v1/messages' })
    lat.push(performance.now() - t0)
    const blocked = res.action === 'block'
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
  return { tp, fn, tn, fp, recall, fpr, p50, missed, falsePos }
}

async function main() {
  const preset = process.argv[2] ?? 'cheap'
  const model = process.argv[3] ?? 'qwen2.5:3b'
  const config = buildConfig(preset, model)
  const pipeline = new Pipeline(config)
  await pipeline.init()

  const datasets = [
    load('deepset-prompt-injections.json', 'deepset (public)'),
    load('heldout.json', 'heldout (novel)'),
  ]

  console.log(`\n=== Benchmark — preset='${preset}'${preset.startsWith('judge') ? ` model='${model}'` : ''} ===`)
  for (const ds of datasets) {
    const r = await evalDataset(pipeline, ds)
    console.log(`\n[${ds.name}]  n=${ds.rows.length}`)
    console.log(`  recall (attacks blocked) : ${(r.recall * 100).toFixed(1)}%  (${r.tp}/${r.tp + r.fn})`)
    console.log(`  FPR    (benign blocked)  : ${(r.fpr * 100).toFixed(1)}%  (${r.fp}/${r.fp + r.tn})`)
    console.log(`  p50 latency              : ${r.p50.toFixed(0)} ms`)
    if (r.missed.length) console.log(`  missed:\n    ${r.missed.join('\n    ')}`)
    if (r.falsePos.length) console.log(`  false positives:\n    ${r.falsePos.join('\n    ')}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
