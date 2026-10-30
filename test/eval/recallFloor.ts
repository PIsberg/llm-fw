/**
 * Direct-injection recall floor gate.
 *
 * Runs the direct-injection splits (gandalf, safeguard, deepset, heldout,
 * jailbreak-classification) and the identifier-free indirect-injection probe
 * (#535) through the cheap pipeline, the default config with the judge and the
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
import { DIRECT_RECALL_FLOORS, INDIRECT_RECALL_FLOORS, evaluateRecallFloor, countUnseen, type SplitCount, type RecallFloor } from './lib/recallFloor.js'
import { SEEN_ROWS } from './lib/seenRows.js'

async function main(): Promise<void> {
  const config = structuredClone(DEFAULT_CONFIG)
  config.detection.judgeEnabled = false
  if (config.detection.classifier) config.detection.classifier.enabled = false
  const pipeline = new Pipeline(config)
  await pipeline.init()

  const counts: Record<string, SplitCount> = {}
  const unseen: Record<string, SplitCount> = {}
  const floors: Record<string, RecallFloor> = { ...DIRECT_RECALL_FLOORS, ...INDIRECT_RECALL_FLOORS }
  for (const dataset of loadAll().filter(d => d.name in floors)) {
    const attackRows = dataset.rows.flatMap((r, i) => (r.label === 1 ? [i] : []))
    const blocked = new Set<number>()
    for (const i of attackRows) {
      const res = await pipeline.run('/v1/messages', anthropicRequestFor(dataset.rows[i]!, 'toolu_bench'), { target: 'bench', method: 'POST', path: '/v1/messages' })
      if (res.action === 'block') blocked.add(i)
    }
    counts[dataset.name] = { blocked: blocked.size, attacks: attackRows.length }
    if (floors[dataset.name]?.benign) {
      const benignRows = dataset.rows.filter(r => r.label === 0)
      let benignBlocked = 0
      for (const row of benignRows) {
        const res = await pipeline.run('/v1/messages', anthropicRequestFor(row, 'toolu_bench'), { target: 'bench', method: 'POST', path: '/v1/messages' })
        if (res.action === 'block') benignBlocked++
      }
      counts[dataset.name] = { ...counts[dataset.name]!, benignBlocked, benign: benignRows.length }
    }
    unseen[dataset.name] = countUnseen(attackRows, blocked, new Set((SEEN_ROWS[dataset.name] ?? []).map(([i]) => i)))
  }
  await pipeline.close()

  console.log(`Direct-injection recall floor, ruleset ${RULESET_VERSION}, cheap pipeline`)
  // Unseen: the rows nobody read while writing a rule (lib/seenRows.ts), the
  // number to quote for generalisation. The floor gates every row.
  let blocked = 0
  let attacks = 0
  let unseenBlocked = 0
  let unseenAttacks = 0
  for (const [name, floor] of Object.entries(DIRECT_RECALL_FLOORS)) {
    const c = counts[name]
    const u = unseen[name]
    if (c) { blocked += c.blocked; attacks += c.attacks }
    if (u) { unseenBlocked += u.blocked; unseenAttacks += u.attacks }
    const benign = floor.benign && c ? `  benign blocked ${c.benignBlocked ?? 0}/${c.benign ?? 0} (ceiling ${floor.benign.maxBlocked})` : ''
    console.log(`  ${name.padEnd(30)} ${c ? `${c.blocked}/${c.attacks}` : 'not run'}  (floor ${floor.minBlocked})  unseen ${u ? `${u.blocked}/${u.attacks}` : '-'}${benign}`)
  }
  console.log(`  ${'total'.padEnd(30)} ${blocked}/${attacks}  unseen ${unseenBlocked}/${unseenAttacks}`)

  console.log('Indirect-injection recall floor (identifier-free probe, #535)')
  for (const [name, floor] of Object.entries(INDIRECT_RECALL_FLOORS)) {
    const c = counts[name]
    const benign = floor.benign && c ? `  benign blocked ${c.benignBlocked ?? 0}/${c.benign ?? 0} (ceiling ${floor.benign.maxBlocked})` : ''
    console.log(`  ${name.padEnd(30)} ${c ? `${c.blocked}/${c.attacks}` : 'not run'}  (floor ${floor.minBlocked})${benign}`)
  }

  const direct = evaluateRecallFloor(counts, DIRECT_RECALL_FLOORS)
  const indirect = evaluateRecallFloor(counts, INDIRECT_RECALL_FLOORS)
  for (const name of [...direct.improved, ...indirect.improved]) {
    console.log(`::notice::${name} clears its floor or ceiling by more than the margin: tighten it in test/eval/lib/recallFloor.ts`)
  }
  if (!direct.passed || !indirect.passed) {
    for (const f of direct.failures) console.log(`::error::direct-injection recall below floor: ${f}`)
    for (const f of indirect.failures) console.log(`::error::indirect-injection recall below floor: ${f}`)
    console.log('Find the rows that moved: npm run verdicts:dump on the base and the branch, then npm run verdicts:diff.')
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
