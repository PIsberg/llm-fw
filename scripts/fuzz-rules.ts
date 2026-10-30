/**
 * Mutation-resilience gate (#541).
 *
 * Takes the attacks of the co-tuned corpus (test/detection/fixtures/corpus.json)
 * that the cheap pipeline blocks, applies each meaning-preserving perturbation
 * in test/eval/lib/mutations.ts (homoglyphs, leetspeak, zero-width characters,
 * casing, markdown framing, a polite prefix, synonyms, no punctuation), and
 * reports per perturbation how many variants still block. Encoded attacks get
 * only the framing perturbations: rewriting a character of the payload
 * destroys it. Fails when one
 * falls below its floor in RESILIENCE_FLOORS: a rule narrowed to one wording
 * shows up here before it shows up in production.
 *
 * Seeds come from the co-tuned corpus, never a held-out split, so the report
 * may print rows without exposing an unseen one.
 *
 * Usage:
 *   npm run fuzz:rules            gate against the floors
 *   npm run fuzz:rules -- --verbose   also list the variants that passed
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pipeline } from '../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { RULESET_VERSION } from '../src/detection/ruleset.js'
import { MUTATIONS, mutate, evaluateResilience, RESILIENCE_FLOORS, type ResilienceCount } from '../test/eval/lib/mutations.js'

const corpusPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'detection', 'fixtures', 'corpus.json')

async function main(): Promise<void> {
  const verbose = process.argv.includes('--verbose')
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { attacks: { category: string; prompt: string }[] }
  const config = structuredClone(DEFAULT_CONFIG)
  config.detection.judgeEnabled = false
  if (config.detection.classifier) config.detection.classifier.enabled = false
  const pipeline = new Pipeline(config)
  await pipeline.init()
  const blocks = async (text: string): Promise<boolean> => {
    const body = JSON.stringify({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: text }] })
    return (await pipeline.run('/v1/messages', body, { target: 'fuzz', method: 'POST', path: '/v1/messages' })).action === 'block'
  }

  const counts: Record<string, ResilienceCount> = Object.fromEntries(Object.keys(MUTATIONS).map(m => [m, { kept: 0, total: 0 }]))
  const escaped: string[] = []
  let seeds = 0
  for (const [i, attack] of corpus.attacks.entries()) {
    if (!(await blocks(attack.prompt))) continue
    seeds++
    for (const v of mutate(attack.prompt, i + 1, attack.category === 'encoding')) {
      const c = counts[v.mutation]!
      c.total++
      if (await blocks(v.text)) c.kept++
      else escaped.push(`[${v.mutation}] [${attack.category}] ${v.text.slice(0, 90).replace(/\s+/g, ' ')}`)
    }
  }
  await pipeline.close()

  console.log(`Mutation resilience, ruleset ${RULESET_VERSION}, cheap pipeline, ${seeds} blocked corpus attacks as seeds`)
  for (const [name, c] of Object.entries(counts)) {
    const floor = RESILIENCE_FLOORS[name]
    const floorText = floor ? `  (floor ${floor.kept})` : ''
    const rate = (c.kept / Math.max(1, c.total) * 100).toFixed(1).padStart(5)
    console.log(`  ${name.padEnd(16)} ${String(c.kept).padStart(3)}/${c.total}  ${rate}%${floorText}`)
  }
  if (verbose) for (const e of escaped) console.log(`  passed: ${e}`)

  const verdict = evaluateResilience(counts, RESILIENCE_FLOORS)
  if (!verdict.passed) {
    for (const f of verdict.failures) console.log(`::error::mutation resilience below floor: ${f}`)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
