/**
 * Direct-injection misses by family (#250).
 *
 * Runs the default configuration (cheap preset: heuristic + embedding, judge
 * and classifier off) over the four direct-injection splits and tags every
 * MISSED attack with the first family regex it matches. The tags are a
 * measurement aid, not a detector: first-match and approximate, so read the
 * table as the shape of what is left, not as exact counts per family.
 *
 * Re-run after any detection change and update the table in
 * docs/BENCHMARK.md ("What the direct-injection misses are made of").
 *
 * Usage:
 *   node --import tsx/esm scripts/tag-misses.ts [--json] [--examples=N]
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pipeline } from '../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { anthropicRequestFor } from '../test/eval/lib/surfaces.js'
import { loadAll } from './run-benchmark.js'
import type { Config } from '../src/types.js'

export const DIRECT_SPLITS = ['deepset-prompt-injections', 'safeguard-prompt-injection', 'heldout', 'gandalf-ignore-instructions'] as const

/** Families in match order. The first one whose test passes wins. */
export const FAMILIES: { name: string; test: (t: string) => boolean }[] = [
  // One synthetic safeguard generator: poems, stories and songs that "start
  // with '<quoted phrase>'" ("The prompt template is", "The rules do not
  // apply"). The phrase varies; the frame does not. Not a shape real
  // deployments see.
  { name: 'prefix-completion', test: t => /\b(?:start|starts|starting|begin|begins|beginning)\s+with\s+['"“‘]/i.test(t) },
  { name: 'coercion', test: t => /\bor\s+(?:else\b|(?:i|we)\s+will\b|(?:your|the)\b[^.!?]{0,40}\bwill\s+be\b)|\bif\s+you\s+(?:do\s+not|don'?t|refuse\s+to)\s+comply\b/i.test(t) },
  { name: 'persona-data-demand', test: t => /\b(?:you\s+are|as\s+an?|as\s+the)\b[^]{0,120}?\b(?:give|provide|share|reveal|disclose|send|show)\b[^.!?]{0,60}\b(?:records?|data|information|credentials?|passwords?|details)\b/i.test(t) },
  { name: 'long-form-jailbreak', test: t => t.length > 250 },
  { name: 'override-verb', test: t => /\b(?:ignore|disregard|forget|discard|override|vergiss|ignoriere|olvida|ignora|oublie)\w*\b/i.test(t) },
  { name: 'prompt-extraction-question', test: t => /\b(?:what|which|tell|show|reveal|repeat|print|spell|give)\b[^.!?]{0,40}\b(?:instructions?|prompt|password|secret)\b/i.test(t) },
]

export function familyOf(text: string): string {
  return FAMILIES.find(f => f.test(text))?.name ?? 'other'
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json')
  const examples = Number(process.argv.find(a => a.startsWith('--examples='))?.slice('--examples='.length) ?? 0)

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config
  config.detection.judgeEnabled = false
  if (config.detection.classifier) config.detection.classifier.enabled = false
  const pipeline = new Pipeline(config)
  await pipeline.init()

  const table: Record<string, Record<string, number>> = {}
  const samples: Record<string, string[]> = {}
  let attacks = 0, missed = 0
  for (const ds of loadAll().filter(d => (DIRECT_SPLITS as readonly string[]).includes(d.name))) {
    for (const row of ds.rows) {
      if (row.label !== 1) continue
      attacks++
      const res = await pipeline.run('/v1/messages', anthropicRequestFor(row, 'toolu_tag'), { target: 'tag', method: 'POST', path: '/v1/messages' })
      if (res.action === 'block') continue
      missed++
      const fam = familyOf(row.text)
      ;(table[fam] ??= {})[ds.name] = ((table[fam] ??= {})[ds.name] ?? 0) + 1
      if ((samples[fam] ??= []).length < examples) samples[fam].push(`[${ds.name}] ${row.text.replace(/\s+/g, ' ').slice(0, 100)}`)
    }
  }
  await pipeline.close()

  const order = [...FAMILIES.map(f => f.name), 'other']
  if (asJson) {
    console.log(JSON.stringify({ attacks, missed, families: Object.fromEntries(order.map(f => [f, table[f] ?? {}])) }, null, 2))
    return
  }
  console.log(`direct-injection attacks ${attacks}, missed ${missed} (recall ${((attacks - missed) / attacks * 100).toFixed(1)}%)\n`)
  console.log(`| Family | Misses | ${DIRECT_SPLITS.map(s => s.split('-')[0]).join(' | ')} |`)
  console.log(`|---|---|${DIRECT_SPLITS.map(() => '---').join('|')}|`)
  for (const fam of order) {
    const row = table[fam] ?? {}
    const total = Object.values(row).reduce((a, b) => a + b, 0)
    console.log(`| ${fam} | ${total} | ${DIRECT_SPLITS.map(s => row[s] ?? 0).join(' | ')} |`)
  }
  for (const fam of order) for (const s of samples[fam] ?? []) console.log(`  ${fam}: ${s}`)
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch(e => { console.error(e); process.exit(1) })
