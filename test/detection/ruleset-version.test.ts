import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULESET_VERSION, RULESET_DIGEST, computeRulesetDigest, rulesetFiles } from '../../src/detection/ruleset.js'

/**
 * The gate that makes ruleset versioning real.
 *
 * An operator who is told "you are running ruleset 2026.08.1" needs that string
 * to mean something: the same version must always imply the same verdicts. A
 * version constant that nobody is obliged to bump does not give them that — it
 * drifts silently the first time a threshold moves.
 *
 * So this recomputes a content hash of every file that can change a verdict and
 * fails when it disagrees with the pinned value. A red run here is not a bug;
 * it means detection behaviour changed and the version has not been cut yet.
 */
describe('detection ruleset identity', () => {
  it('covers every detection module, the defaults, and the anchors', () => {
    const files = rulesetFiles()
    expect(files).toContain('src/detection/heuristic.ts')
    expect(files).toContain('src/detection/embedding.ts')
    expect(files).toContain('src/detection/pipeline.ts')
    // Thresholds live in the default config, so a threshold change has to move
    // the digest too.
    expect(files).toContain('src/config/config.ts')
    expect(files).toContain('data/semantic-anchors.json')
    expect(files).toContain('data/semantic-anchors-benign.json')
    // The file holding the digest cannot be part of what it hashes.
    expect(files).not.toContain('src/detection/ruleset.ts')
  })

  it('uses a calendar version', () => {
    expect(RULESET_VERSION).toMatch(/^\d{4}\.\d{2}\.\d+$/)
  })

  it('is the version the published measurements claim to describe', () => {
    // Doc drift found in review: the ruleset was bumped while
    // docs/FALSE-POSITIVES.md still said its 13.38% was measured against an
    // older one, so a reader could not tell whether the number described the
    // shipped code. Rates are only meaningful next to the ruleset that
    // produced them, so the pairing is enforced rather than remembered:
    // after a bump, re-run `npm run fpr` and update the label.
    const root = fileURLToPath(new URL('../../', import.meta.url))
    for (const rel of ['docs/FALSE-POSITIVES.md', 'test/eval/fpr.ts']) {
      const text = readFileSync(join(root, rel), 'utf8')
      expect(
        text,
        `${rel} does not mention ruleset ${RULESET_VERSION}. Re-run the measurement it reports and update the label.`,
      ).toContain(RULESET_VERSION)
    }
  })

  it('matches the pinned digest', () => {
    const actual = computeRulesetDigest()
    expect(
      actual,
      [
        '',
        'Detection behaviour changed but the ruleset version was not cut.',
        '',
        'A verdict is only reproducible if the ruleset id tracks the rules, so:',
        '  1. bump RULESET_VERSION in src/detection/ruleset.ts',
        '  2. set RULESET_DIGEST to: ' + actual,
        '  3. record the measured recall/FPR delta in CHANGELOG.md',
        '',
        'Run `npm run ruleset:digest` to recompute.',
        '',
      ].join('\n'),
    ).toBe(RULESET_DIGEST)
  })
})
