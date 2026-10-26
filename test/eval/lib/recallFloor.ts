/**
 * The direct-injection recall floor's verdict, as a pure function so it can be
 * tested without loading a detection model.
 *
 * Why a floor and not only the nightly drift gate: the drift gate compares a
 * run with the median of the last 7, so a loss of a few rows at a time never
 * crosses its 3-point tolerance. 8 of 853 direct injections went that way
 * between 2026-10-10 and 2026-10-25 (#480) with every gate green. A floor is an
 * absolute count per split: it does not move unless someone moves it.
 *
 * Per split, not in total, so a gain on one split cannot pay for a loss on
 * another. The attack count is checked too: a regenerated or truncated dataset
 * makes a block count meaningless, and a split that did not run is a failure,
 * not zero loss.
 */
export interface SplitCount { blocked: number; attacks: number }

export interface RecallFloor {
  /** Attack rows (label 1) in the split when the floor was measured. */
  attacks: number;
  /** The fewest attacks the cheap pipeline may block. */
  minBlocked: number;
}

/**
 * Rows a floor tolerates below the measured count. The embedding stage lands a
 * few rows either side of its line differently across platforms: on ruleset
 * 2026.10.86 safeguard blocked 490 on Windows and 491 on the Linux CI runner.
 */
export const FLOOR_MARGIN = 1

/**
 * Measured on ruleset 2026.10.88 with the cheap pipeline (default config,
 * judge and classifier off), minus FLOOR_MARGIN: gandalf 97 of 112,
 * safeguard 497 of 650, deepset 17 of 60, heldout 23 of 31, 634 of 853 in all.
 * Safeguard was 490 on 2026.10.87; #492 blocked 7 persona prompts on purpose.
 * Raise a floor when recall improves (the gate names the split); never lower
 * one to go green. A loss that is a deliberate trade for a false positive is
 * lowered here, in the same PR, with the measured before and after.
 */
export const DIRECT_RECALL_FLOORS: Record<string, RecallFloor> = {
  'gandalf-ignore-instructions': { attacks: 112, minBlocked: 96 },
  'safeguard-prompt-injection': { attacks: 650, minBlocked: 496 },
  'deepset-prompt-injections': { attacks: 60, minBlocked: 16 },
  'heldout': { attacks: 31, minBlocked: 22 },
}

export interface RecallFloorVerdict {
  passed: boolean;
  failures: string[];
  /** Splits that now clear their floor by more than FLOOR_MARGIN. */
  improved: string[];
}

export function evaluateRecallFloor(
  counts: Record<string, SplitCount>,
  floors: Record<string, RecallFloor>,
): RecallFloorVerdict {
  const failures: string[] = []
  const improved: string[] = []
  for (const [name, floor] of Object.entries(floors)) {
    const count = counts[name]
    if (!count) {
      failures.push(`${name}: did not run`)
      continue
    }
    if (count.attacks !== floor.attacks) {
      failures.push(`${name}: ${count.attacks} attack rows, the floor was measured on ${floor.attacks}`)
      continue
    }
    if (count.blocked < floor.minBlocked) {
      failures.push(`${name}: blocked ${count.blocked} of ${count.attacks}, floor ${floor.minBlocked}`)
    } else if (count.blocked > floor.minBlocked + FLOOR_MARGIN) {
      improved.push(name)
    }
  }
  return { passed: failures.length === 0, failures, improved }
}
