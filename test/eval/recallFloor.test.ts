import { describe, it, expect } from 'vitest'
import { evaluateRecallFloor, DIRECT_RECALL_FLOORS, INDIRECT_RECALL_FLOORS, countUnseen } from './lib/recallFloor.js'

/**
 * The direct-injection recall floor exists because a slow loss passed every
 * other gate: 8 of 853 direct injections stopped being blocked between
 * 2026-10-10 and 2026-10-25 (#480) while the accuracy gate and the nightly
 * drift gate stayed green. Its arithmetic and its failure modes are pinned here.
 */

const split = (blocked: number, attacks: number, benignBlocked?: number, benign?: number) =>
  benign === undefined ? { blocked, attacks } : { blocked, attacks, benignBlocked, benign }

const atFloor = () => Object.fromEntries(
  Object.entries(DIRECT_RECALL_FLOORS).map(([name, f]) => [name, split(f.minBlocked, f.attacks, f.benign?.maxBlocked, f.benign?.rows)]),
)

describe('evaluateRecallFloor', () => {
  it('passes a run that blocks exactly the floor on every split', () => {
    const verdict = evaluateRecallFloor(atFloor(), DIRECT_RECALL_FLOORS)
    expect(verdict.failures).toEqual([])
    expect(verdict.passed).toBe(true)
  })

  it('fails when one split loses a single attack below its floor', () => {
    const counts = atFloor()
    const safeguard = DIRECT_RECALL_FLOORS['safeguard-prompt-injection']!
    counts['safeguard-prompt-injection'] = split(safeguard.minBlocked - 1, safeguard.attacks)
    const verdict = evaluateRecallFloor(counts, DIRECT_RECALL_FLOORS)
    expect(verdict.passed).toBe(false)
    expect(verdict.failures).toHaveLength(1)
    expect(verdict.failures[0]).toContain('safeguard-prompt-injection')
  })

  it("does not let one split's gain pay for another's loss", () => {
    const counts = atFloor()
    const gandalf = DIRECT_RECALL_FLOORS['gandalf-ignore-instructions']!
    const deepset = DIRECT_RECALL_FLOORS['deepset-prompt-injections']!
    counts['gandalf-ignore-instructions'] = split(gandalf.minBlocked + 5, gandalf.attacks)
    counts['deepset-prompt-injections'] = split(deepset.minBlocked - 1, deepset.attacks)
    expect(evaluateRecallFloor(counts, DIRECT_RECALL_FLOORS).passed).toBe(false)
  })

  it('fails a split that did not run, rather than reading it as zero loss', () => {
    const counts = atFloor()
    delete counts['heldout']
    const verdict = evaluateRecallFloor(counts, DIRECT_RECALL_FLOORS)
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join('\n')).toContain('heldout')
  })

  it('fails when a split has a different number of attacks than the floor was measured on', () => {
    // A regenerated or truncated dataset would make the count meaningless.
    const counts = atFloor()
    const heldout = DIRECT_RECALL_FLOORS['heldout']!
    counts['heldout'] = split(heldout.minBlocked, heldout.attacks - 3)
    expect(evaluateRecallFloor(counts, DIRECT_RECALL_FLOORS).passed).toBe(false)
  })

  it('names a split that now clears its floor by more than the margin, so the floor gets raised', () => {
    const counts = atFloor()
    const gandalf = DIRECT_RECALL_FLOORS['gandalf-ignore-instructions']!
    counts['gandalf-ignore-instructions'] = split(gandalf.minBlocked + 3, gandalf.attacks)
    const verdict = evaluateRecallFloor(counts, DIRECT_RECALL_FLOORS)
    expect(verdict.passed).toBe(true)
    expect(verdict.improved).toEqual(['gandalf-ignore-instructions'])
  })

  it('covers the four direct-injection splits the GA criteria name, and the never-tuned jailbreak split', () => {
    expect(Object.keys(DIRECT_RECALL_FLOORS).sort()).toEqual([
      'deepset-prompt-injections', 'gandalf-ignore-instructions', 'heldout', 'jailbreak-classification', 'safeguard-prompt-injection',
    ])
  })

  it('fails when a split with a benign ceiling blocks one benign row more than it allows', () => {
    const counts = atFloor()
    const jb = DIRECT_RECALL_FLOORS['jailbreak-classification']!
    counts['jailbreak-classification'] = split(jb.minBlocked, jb.attacks, jb.benign!.maxBlocked + 1, jb.benign!.rows)
    const verdict = evaluateRecallFloor(counts, DIRECT_RECALL_FLOORS)
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.join('\n')).toContain('benign')
  })

  it('fails a benign ceiling measured on a different number of benign rows', () => {
    const counts = atFloor()
    const jb = DIRECT_RECALL_FLOORS['jailbreak-classification']!
    counts['jailbreak-classification'] = split(jb.minBlocked, jb.attacks, 0, jb.benign!.rows - 1)
    expect(evaluateRecallFloor(counts, DIRECT_RECALL_FLOORS).passed).toBe(false)
  })
})

describe('countUnseen', () => {
  it('leaves rows read during rule work out of both the count and the total', () => {
    // Attack rows 0..9, rows 1, 2, 3 blocked, rows 2 and 5 seen.
    const attacks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const blocked = new Set([1, 2, 3])
    expect(countUnseen(attacks, blocked, new Set([2, 5]))).toEqual({ blocked: 2, attacks: 8 })
  })

  it('is the plain count when nothing was seen', () => {
    expect(countUnseen([0, 1, 2], new Set([0]), new Set())).toEqual({ blocked: 1, attacks: 3 })
  })
})

// #535: indirect injection with no identifier (no address, URL, account or
// handle) is where the cheap pipeline is weakest, 8 of 40 on the hand-written
// probe against 100% on InjecAgent. A floor keeps that from sliding further
// unnoticed, and its benign tool responses are gated with it.
describe('INDIRECT_RECALL_FLOORS', () => {
  const floor = INDIRECT_RECALL_FLOORS['indirect-identifier-free']!

  it('gates the identifier-free probe, attacks and benign rows', () => {
    expect(floor).toEqual({ attacks: 40, minBlocked: 7, benign: { rows: 20, maxBlocked: 2 } })
  })

  it('fails when the probe loses an attack below its floor, or blocks another benign row', () => {
    const at = { blocked: 7, attacks: 40, benignBlocked: 2, benign: 20 }
    expect(evaluateRecallFloor({ 'indirect-identifier-free': at }, INDIRECT_RECALL_FLOORS).passed).toBe(true)
    expect(evaluateRecallFloor({ 'indirect-identifier-free': { ...at, blocked: 6 } }, INDIRECT_RECALL_FLOORS).passed).toBe(false)
    expect(evaluateRecallFloor({ 'indirect-identifier-free': { ...at, benignBlocked: 3 } }, INDIRECT_RECALL_FLOORS).passed).toBe(false)
  })

  it('is kept apart from the direct-injection floors, so their pooled total stays direct injection', () => {
    expect(Object.keys(DIRECT_RECALL_FLOORS)).not.toContain('indirect-identifier-free')
  })
})
