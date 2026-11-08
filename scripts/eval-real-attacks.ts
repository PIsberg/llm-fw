/**
 * Recall on attacks written by people trying to beat a deployed defence:
 * LLMail-Inject (Microsoft's 2024-25 challenge, indirect injection in emails)
 * and Tensor Trust (a game's hijack and extraction attacks).
 *
 * The corpora are built locally by `scripts/fetch-eval-data.ts real-attacks`
 * into test/eval/data/local/ (gitignored: Tensor Trust ships no licence) and
 * split by the sha256 of each text: `tune` may be read when changing a rule,
 * `heldout` may not. Report the held-out numbers.
 *
 * Usage: node --import tsx/esm scripts/eval-real-attacks.ts <tune|heldout> [cheap|classifier] [--save]
 *   --save  write each row's action and rule ids next to the corpus, for
 *           reading the misses on the tune split. Refused for heldout.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pipeline } from '../src/detection/pipeline.js'
import { anthropicRequestFor, type EvalRow } from '../test/eval/lib/surfaces.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import type { Config } from '../src/types.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'eval', 'data', 'local')
const split = process.argv[2]
const preset = process.argv[3] ?? 'cheap'
if (split !== 'tune' && split !== 'heldout') throw new Error('split: tune | heldout')
const save = process.argv.includes('--save')
if (save && split === 'heldout') throw new Error('--save is for the tune split only')

const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config
config.detection.judgeEnabled = false
const cls = config.detection.classifier
if (cls) { cls.enabled = preset === 'classifier'; cls.requireCorroboration = false }

const rows = (JSON.parse(readFileSync(join(dir, `real-attacks-${split}.json`), 'utf8')) as { rows: EvalRow[] }).rows
const pipeline = new Pipeline(config)
await pipeline.init()

const stats = new Map<string, { n: number; block: number; warn: number }>()
const verdicts: { action: string; stage: string; score: number; similarity: number; rules: string[] }[] = []
for (const r of rows) {
  const res = await pipeline.run('/v1/messages', anthropicRequestFor(r, 'toolu_eval'), { target: 'eval', method: 'POST', path: '/v1/messages' })
  const s = stats.get(r.class ?? '?') ?? { n: 0, block: 0, warn: 0 }
  s.n++
  if (res.action === 'block') s.block++
  else if (res.action === 'warn') s.warn++
  stats.set(r.class ?? '?', s)
  if (save) verdicts.push({ action: res.action, stage: res.stage, score: res.score, similarity: res.similarity, rules: res.heuristicMatches ?? [] })
}
const pct = (a: number, n: number) => `${((a / n) * 100).toFixed(1)}%`.padStart(6)
console.log(`split=${split} preset=${preset}`)
for (const [c, s] of [...stats].sort()) {
  console.log(`  ${c.padEnd(28)} n=${String(s.n).padStart(5)}  block ${pct(s.block, s.n)}  warn ${pct(s.warn, s.n)}`)
}
if (save) writeFileSync(join(dir, `real-attacks-${split}.${preset}.verdicts.json`), JSON.stringify(verdicts))
