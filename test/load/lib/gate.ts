/**
 * The accuracy gate's verdict, as a pure function.
 *
 * Extracted from accuracy.ts so the decision can be tested directly. The
 * failure mode this exists to prevent was found the hard way: the gate used to
 * report PASSED on a run where *nothing was graded at all*. With zero graded
 * requests both rates compute to 0, an FPR of 0 clears any ceiling, and the TPR
 * floor was explicitly skipped ("only check it if there were attacks"). So a
 * broken harness — proxy never up, every request erroring — produced a green
 * accuracy gate, and the scorecard generator then published a table reading
 * 0/0 for every attack class.
 *
 * A skipped gate is not a passed gate, so coverage is checked first and the
 * TPR floor has no escape hatch.
 */
export interface GateInput {
  tn: number;
  fp: number;
  tp: number;
  fn: number;
  /** Requests that never produced a verdict (connection/TLS/timeout). */
  errCount: number;
  /** Requests this run intended to grade. */
  planned: number;
  fprMax: number;
  tprMin: number;
}

export interface GateVerdict {
  passed: boolean;
  failures: string[];
  /** Requests that actually produced a verdict. */
  graded: number;
  fpr: number;
  tpr: number;
}

export function evaluateGate(input: GateInput): GateVerdict {
  const { tn, fp, tp, fn, errCount, planned, fprMax, tprMin } = input;

  const fpr = (tn + fp) > 0 ? (fp / (tn + fp)) * 100 : 0;
  const tpr = (tp + fn) > 0 ? (tp / (tp + fn)) * 100 : 0;
  const graded = tn + fp + tp + fn;

  const failures: string[] = [];

  // Coverage first: it is what distinguishes "the corpus was measured and the
  // detector did badly" from "the corpus was never measured".
  if (graded === 0) {
    failures.push(
      `gate measured NOTHING: 0 of ${planned} planned requests were graded ` +
      `(${errCount} errored). Every rate reported is vacuous.`,
    );
  } else if (graded < planned) {
    failures.push(
      `incomplete run: ${graded} of ${planned} planned requests were graded ` +
      `(${errCount} errored). Rates from a partial corpus are not comparable.`,
    );
  }

  if (fpr > fprMax) {
    failures.push(`FPR ${fpr.toFixed(2)}% exceeds ceiling of ${fprMax}% (${fp} benign blocked)`);
  }
  // No "only when attacks were present" condition: the coverage check above
  // already separates a broken run from a detection regression, and both must
  // be red.
  if (tpr < tprMin) {
    failures.push(`TPR ${tpr.toFixed(2)}% below floor of ${tprMin}% (${fn} attacks missed)`);
  }

  return { passed: failures.length === 0, failures, graded, fpr, tpr };
}
