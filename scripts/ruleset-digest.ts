/**
 * Print the detection ruleset digest.
 *
 * The digest covers every file that can change a verdict: the detection
 * modules, the default thresholds in config.ts, and the embedding anchor sets.
 * `test/detection/ruleset-version.test.ts` recomputes it and fails when it
 * drifts from the pinned value in src/detection/ruleset.ts, which is what
 * forces a conscious ruleset version bump whenever detection behaviour moves.
 *
 * Usage: npm run ruleset:digest
 */
import { rulesetFiles, computeRulesetDigest } from '../src/detection/ruleset.js';

const digest = computeRulesetDigest();
console.log(`files:  ${rulesetFiles().length}`);
console.log(`digest: ${digest}`);
