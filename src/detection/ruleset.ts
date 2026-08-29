import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Detection ruleset identity.
 *
 * The npm version tells an operator which BUILD they run; it says nothing
 * about which DETECTION BEHAVIOUR they run, because a patch release can change
 * a threshold and a feature release can leave detection untouched. An auditor
 * asking "which rules produced this verdict, and can I reproduce it?" needs a
 * separate, stable identifier — this one.
 *
 * Format: YYYY.MM.N — the calendar month the ruleset was cut, plus a counter
 * within that month.
 *
 * ## Why the digest exists
 *
 * A version constant nobody is forced to bump is decoration. RULESET_DIGEST is
 * a content hash over every file that can change a verdict; the test
 * `test/detection/ruleset-version.test.ts` recomputes it and fails when the two
 * disagree. So any change to detection logic, default thresholds, or the
 * embedding anchors makes CI red until the author bumps the version and
 * records the new digest — which is also the moment the changelog entry gets
 * written.
 *
 * To update after an intended detection change:
 *   1. npm run ruleset:digest
 *   2. bump RULESET_VERSION, paste the new digest into RULESET_DIGEST
 *   3. run the HELD-OUT benchmarks and record the delta in CHANGELOG.md:
 *        node --import tsx/esm scripts/run-benchmark.ts cheap --json \
 *          --only=heldout,injecagent,safeguard-prompt-injection
 *   4. run `npm run fpr` and record that delta too
 *
 * Step 3 is not optional, and it is not covered by `npm test`. Rulesets
 * 2026.08.7 and 2026.08.8 were both merged on a green suite — scorecard TPR
 * 100%, accuracy.eval passing, FPR improved — and the nightly drift gate then
 * reported injecagent recall 100% -> 85.5%, heldout 61.3% -> 54.8% and
 * safeguard 43.5% -> 39.1%. The scorecard and accuracy corpora are CO-TUNED:
 * they cannot see a regression in the attack families they do not contain, so
 * a green run there is evidence about those corpora and nothing else. Only the
 * held-out splits answer "did this cost recall".
 */
export const RULESET_VERSION = '2026.08.13';

/**
 * sha256 over RULESET_FILES (path + content, sorted, newlines normalised).
 * Regenerate with `npm run ruleset:digest`.
 */
export const RULESET_DIGEST = '7fb9b78b35c6c28b858739dd302c653813fda843440b2abb111466582983dd4d';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root, from either src/detection or dist/detection. */
const ROOT = path.resolve(HERE, '..', '..');

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/**
 * Every file whose content can change a verdict, repo-relative and sorted.
 *
 * Source-tree only — this reads `src/`, so it is used by the test and the
 * digest script, never on the request path. A packaged install has no `src/`
 * and calls neither.
 */
export function rulesetFiles(): string[] {
  const detectionDir = path.join(ROOT, 'src', 'detection');
  if (!fs.existsSync(detectionDir)) return [];
  const files = [
    ...walkTs(detectionDir),
    path.join(ROOT, 'src', 'config', 'config.ts'),
    path.join(ROOT, 'data', 'semantic-anchors.json'),
    path.join(ROOT, 'data', 'semantic-anchors-benign.json'),
  ];
  return files
    .map(f => path.relative(ROOT, f).split(path.sep).join('/'))
    // The digest cannot cover the file that stores it.
    .filter(f => f !== 'src/detection/ruleset.ts')
    .sort();
}

/** Recompute the digest from the working tree. Source-tree only. */
export function computeRulesetDigest(): string {
  const hash = crypto.createHash('sha256');
  for (const rel of rulesetFiles()) {
    hash.update(rel);
    // Normalise line endings so a checkout with CRLF hashes the same as one
    // with LF — otherwise the gate would fire on Windows for every file.
    hash.update(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex');
}
