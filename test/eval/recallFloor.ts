/**
 * Direct-injection recall floor gate.
 *
 * Runs the four direct-injection splits (gandalf, safeguard, deepset, heldout)
 * through the cheap pipeline, the default config with the judge and the
 * classifier off, and fails when any split blocks fewer attacks than its floor
 * in lib/recallFloor.ts. The accuracy gate cannot see this: it runs its own
 * co-tuned corpus. The nightly drift gate compares with a moving median, so a
 * loss of a row or two at a time never trips it (#480).
 *
 * When it fails, find the rows that moved with `npm run verdicts:dump` on the
 * base and on the branch, then `npm run verdicts:diff`.
 *
 * Usage:
 *   npm run recall:floor
 */
import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { RULESET_VERSION } from '../../src/detection/ruleset.js'
import { loadAll } from '../../scripts/run-benchmark.js'
import { anthropicRequestFor } from './lib/surfaces.js'
import { DIRECT_RECALL_FLOORS, evaluateRecallFloor, type SplitCount } from './lib/recallFloor.js'

async function main(): Promise<void> {
  const config = structuredClone(DEFAULT_CONFIG)
  config.detection.judgeEnabled = false
  if (config.detection.classifier) config.detection.classifier.enabled = false
  const pipeline = new Pipeline(config)
  await pipeline.init()

  const counts: Record<string, SplitCount> = {}
  for (const dataset of loadAll().filter(d => d.name in DIRECT_RECALL_FLOORS)) {
    const attacks = dataset.rows.filter(r => r.label === 1)
    let blocked = 0
    for (const row of attacks) {
      const res = await pipeline.run('/v1/messages', anthropicRequestFor(row, 'toolu_bench'), { target: 'bench', method: 'POST', path: '/v1/messages' })
      if (res.action === 'block') blocked++
    }
    counts[dataset.name] = { blocked, attacks: attacks.length }
  }
  await pipeline.close()

  console.log(`Direct-injection recall floor, ruleset ${RULESET_VERSION}, cheap pipeline`)
  let blocked = 0
  let attacks = 0
  for (const [name, floor] of Object.entries(DIRECT_RECALL_FLOORS)) {
    const c = counts[name]
    if (c) { blocked += c.blocked; attacks += c.attacks }
    console.log(`  ${name.padEnd(30)} ${c ? `${c.blocked}/${c.attacks}` : 'not run'}  (floor ${floor.minBlocked})`)
  }
  console.log(`  ${'total'.padEnd(30)} ${blocked}/${attacks}`)

  const verdict = evaluateRecallFloor(counts, DIRECT_RECALL_FLOORS)
  for (const name of verdict.improved) {
    console.log(`::notice::${name} clears its recall floor by more than the margin: raise it in test/eval/lib/recallFloor.ts`)
  }
  if (!verdict.passed) {
    for (const f of verdict.failures) console.log(`::error::direct-injection recall below floor: ${f}`)
    console.log('Find the rows that moved: npm run verdicts:dump on the base and the branch, then npm run verdicts:diff.')
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
