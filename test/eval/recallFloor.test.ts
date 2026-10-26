import { describe, it, expect } from 'vitest'
import { evaluateRecallFloor, DIRECT_RECALL_FLOORS } from './lib/recallFloor.js'

/**
 * The direct-injection recall floor exists because a slow loss passed every
 * other gate: 8 of 853 direct injections stopped being blocked between
 * 2026-10-10 and 2026-10-25 (#480) while the accuracy gate and the nightly
 * drift gate stayed green. Its arithmetic and its failure modes are pinned here.
 */

const split = (blocked: number, attacks: number) => ({ blocked, attacks })

const atFloor = () => Object.fromEntries(
  Object.entries(DIRECT_RECALL_FLOORS).map(([name, f]) => [name, split(f.minBlocked, f.attacks)]),
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

  it('covers the four direct-injection splits the GA criteria name', () => {
    expect(Object.keys(DIRECT_RECALL_FLOORS).sort()).toEqual([
      'deepset-prompt-injections', 'gandalf-ignore-instructions', 'heldout', 'safeguard-prompt-injection',
    ])
  })
})
