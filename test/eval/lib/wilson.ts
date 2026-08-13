/**
 * Wilson score interval for a binomial proportion.
 *
 * Why this exists: llm-fw's published false-positive rates have rested on
 * benign samples of 17 to 21 rows. "0% FPR" from 0/17 sounds like a
 * measurement and is not one — the 95% Wilson interval on 0/17 reaches about
 * 18%, so that sample cannot distinguish a firewall that never blocks benign
 * traffic from one that blocks nearly a fifth of it. The normal approximation
 * is worse than useless here: at p̂ = 0 it produces the interval [0, 0],
 * reporting perfect certainty from no evidence at all.
 *
 * Wilson stays sensible at the extremes, which is exactly where FPR lives.
 */

/** 95% two-sided normal quantile. */
const Z_95 = 1.959963984540054;

export interface Interval {
  /** Observed proportion, failures / n. */
  point: number;
  lower: number;
  upper: number;
  n: number;
  failures: number;
}

/**
 * Wilson score interval at 95% confidence.
 * `n === 0` yields the uninformative [0, 1]: no observations, no knowledge.
 */
export function wilsonInterval(failures: number, n: number, z: number = Z_95): Interval {
  if (n <= 0) return { point: 0, lower: 0, upper: 1, n: 0, failures: 0 };

  const p = failures / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  return {
    point: p,
    lower: Math.max(0, (centre - spread) / denom),
    upper: Math.min(1, (centre + spread) / denom),
    n,
    failures,
  };
}

/**
 * The smallest sample that could support a claim of "FPR ≤ slo" — that is, the
 * n at which a clean run (zero failures) has a 95% upper bound at or under the
 * SLO. Reported alongside every result so a small clean sample is read as
 * "not yet enough evidence" rather than as a pass.
 *
 * With zero failures the Wilson upper bound reduces to z²/(n + z²), so the
 * answer is z²(1 − slo)/slo, rounded up.
 */
export function sampleNeededFor(slo: number, z: number = Z_95): number {
  if (slo <= 0) return Infinity;
  if (slo >= 1) return 1;
  return Math.ceil((z * z * (1 - slo)) / slo);
}

/** Format an interval as a percentage string, e.g. "0.00% (95% CI 0.00–1.24%)". */
export function formatInterval(interval: Interval): string {
  const pct = (v: number): string => (v * 100).toFixed(2);
  return `${pct(interval.point)}% (95% CI ${pct(interval.lower)}–${pct(interval.upper)}%)`;
}
