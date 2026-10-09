/**
 * Which benign corpora a `npm run fpr` run scans, and whether a corpus can fail
 * it. Pure, so it can be tested without loading a detection model.
 *
 * Most corpora are committed and gate every pull request. An `optIn` corpus is
 * only scanned when named with `--only=<name>[,<name>]`; the full Dolly-15k set
 * (#256) is one, because it is fetched rather than committed and takes minutes.
 * A `reportOnly` corpus prints its per-category table and its breaches, but its
 * breaches do not fail the run, with one exception: a corpus that scanned
 * nothing still fails, so a missing fetch cannot pass for a clean night.
 */
import { evaluateFprGate, type FprGateInput } from './fprGate.js';

export interface CorpusFlags {
  name: string;
  /** Scanned only when named by `--only`. */
  optIn?: boolean;
  /** Breaches are reported, not failed. */
  reportOnly?: boolean;
}

export function selectCorpora<T extends CorpusFlags>(all: T[], argv: string[]): T[] {
  const only = argv.find(a => a.startsWith('--only='));
  if (only === undefined) return all.filter(c => !c.optIn);

  const names = only.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('--only needs at least one corpus name');
  return names.map(name => {
    const corpus = all.find(c => c.name === name);
    if (!corpus) throw new Error(`unknown corpus '${name}', known: ${all.map(c => c.name).join(', ')}`);
    return corpus;
  });
}

export interface CorpusVerdict {
  /** Breaches that fail the run. */
  failures: string[];
  /** Every breach, failed or not, for the log. */
  reported: string[];
  /** Categories now below their ceiling. */
  improved: string[];
}

export function corpusVerdict(corpus: CorpusFlags, input: FprGateInput): CorpusVerdict {
  const verdict = evaluateFprGate(input);
  const failures = corpus.reportOnly && input.scanned > 0 ? [] : verdict.failures;
  return { failures, reported: verdict.failures, improved: verdict.improved };
}
