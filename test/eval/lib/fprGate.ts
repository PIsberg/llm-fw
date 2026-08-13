/**
 * The false-positive gate's verdict, as a pure function so it can be tested
 * without loading a detection model.
 *
 * Two checks, because either alone is weak:
 *
 *  - An overall SLO catches broad drift, but hides category rot: the clean
 *    categories could go from 0% to 30% while the total stayed under the SLO,
 *    masked by the categories that are already bad.
 *  - Per-category ceilings catch that, and default to ZERO for any category not
 *    listed, so the first false positive in a currently-clean category fails
 *    the build instead of being absorbed.
 *
 * Coverage is checked first for the same reason the accuracy gate checks it: a
 * run that scanned nothing produces an FPR of 0, which clears every threshold.
 */
export interface CategoryCount { n: number; blocked: number }

export interface FprGateInput {
  perClass: Record<string, CategoryCount>;
  blocked: number;
  scanned: number;
  /** Rows the corpus contains, to detect a partial run. */
  expected: number;
  sloPct: number;
  /** Max blocked rows per category; absent means zero tolerated. */
  ceilings: Record<string, number>;
}

export interface FprGateVerdict {
  passed: boolean;
  failures: string[];
  /** Categories whose measured count is now BELOW their ceiling. */
  improved: string[];
  fprPct: number;
}

export function evaluateFprGate(input: FprGateInput): FprGateVerdict {
  const { perClass, blocked, scanned, expected, sloPct, ceilings } = input;
  const failures: string[] = [];
  const improved: string[] = [];

  if (scanned === 0) {
    failures.push(`gate measured NOTHING: 0 of ${expected} benign rows scanned. An FPR of 0 here is vacuous.`);
  } else if (scanned !== expected) {
    failures.push(`incomplete run: scanned ${scanned} of ${expected} rows — a partial corpus cannot support a rate.`);
  }

  const fprPct = scanned > 0 ? (blocked / scanned) * 100 : 0;
  if (fprPct > sloPct) {
    failures.push(`FPR ${fprPct.toFixed(2)}% exceeds the SLO of ${sloPct}% (${blocked}/${scanned} benign prompts blocked)`);
  }

  for (const [cls, c] of Object.entries(perClass).sort(([a], [b]) => a.localeCompare(b))) {
    const ceiling = ceilings[cls] ?? 0;
    if (c.blocked > ceiling) {
      failures.push(
        `category '${cls}': ${c.blocked}/${c.n} blocked, ceiling ${ceiling}` +
        (ceiling === 0 ? ' (no known false positives in this category — a new one is a regression)' : ''),
      );
    }
  }

  // Reported, never failed: a ceiling that is now too generous means detection
  // improved and the guard should be tightened so the win cannot silently rot.
  for (const [cls, ceiling] of Object.entries(ceilings)) {
    const c = perClass[cls];
    if (c && c.blocked < ceiling) improved.push(cls);
  }

  return { passed: failures.length === 0, failures, improved, fprPct };
}
