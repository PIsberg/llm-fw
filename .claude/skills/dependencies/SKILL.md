---
name: dependencies
description: Review, apply and verify dependency updates for llm-fw — establish what is actually outdated versus merely proposed, separate the bumps that can move detection from the ones that cannot, drive the real gate, and stop before merging. Use when asked to update dependencies, handle Dependabot pull requests, bump a package, check for outdated packages, or investigate why Dependabot has gone quiet.
---

# Updating dependencies in llm-fw

This is a security product whose guarantee is a set of measured numbers:
precision, recall, per-category recall and the false-positive rate. Two kinds
of dependency bump can move those numbers, and one of them moves them silently.
So this skill is mostly about telling the two apart.

**You prepare and verify. A human merges.** Same rule as the `release` skill.

## First: is anything actually wrong?

"Dependabot is not proposing anything" is usually false. Check before acting:

```bash
npm outdated                                   # what is behind, and by how much
gh pr list --state open --json number,title,headRefName \
  --jq '.[] | select(.headRefName | startswith("dependabot/")) | "\(.number) \(.title)"'
gh api repos/PIsberg/llm-fw/dependabot/alerts \
  --jq '[.[] | select(.state=="open")] | group_by(.security_advisory.severity)
        | map({sev: .[0].security_advisory.severity, n: length})'
```

If `npm outdated` lists packages and Dependabot has proposed nothing, the
answer is almost always **the 7-day cooldown in `.github/dependabot.yml`**, not
a fault. Confirm it rather than guessing:

```bash
npm view <package> time --json      # when was the newest version published?
```

A version published fewer than 7 days ago will not be proposed. That delay is
deliberate: a freshly published release is the shape a supply-chain compromise
arrives in. Wait, or bump it by hand knowing why the guard exists.

Silence can also mean `.github/workflows/semgrep-requirements.txt`, which no
ecosystem watches on purpose. See `semgrep-lock-freshness.yml`.

## The distinction that matters

| Bump | Can it move a verdict? | How to treat it |
| --- | --- | --- |
| `@huggingface/transformers` | **Yes, directly.** It produces every embedding. | Full detection re-measurement, below. Expect a `RULESET_VERSION` cut. |
| `vitest`, `@vitest/coverage-v8` | **It measures the verdicts.** | Full gate. A green suite on a new runner is not automatically the same suite. |
| `node-forge` | No, but it issues the CA. | Proxy e2e suite must pass; check certificate tests specifically. |
| `cosmiconfig` | No, but it reads every config file. | Config tests plus one real `llm-fw start`. |
| `tesseract.js` | Yes for image attacks. | Run `test/detection/ocr.test.ts` and `image-attacks.test.ts`. |
| Other dev tooling (patch/minor) | No. | The gate is sufficient. |
| Any **major** | Assume yes until measured. | Everything below, and read the changelog for behaviour changes. |

`@huggingface/transformers` is the one to be slowest about. The cosine
thresholds in `DEFAULT_CONFIG` are calibrated against a specific model and
runtime; a runtime that changes quantization or pooling by a fraction moves
every similarity slightly, and the first sign is the accuracy gate or the FPR
eval shifting by a row or two.

## Applying the update

Group the work rather than taking one Dependabot branch at a time. One branch,
one changelog entry, one review:

```bash
git checkout -b chore/dependency-update-<yyyy-mm>
npm install <pkg>@<version> ...      # or merge the Dependabot branches in
npm ci                               # prove the lockfile resolves cleanly
```

Never hand-edit `package-lock.json`.

## Verifying it

Run the whole gate. Not a subset, because the point is to detect the thing you
did not predict:

```bash
npx tsc --noEmit && npm run lint && npm run build && npm run test:run
```

Then, **for anything in the top four rows of the table above**, re-measure
detection and compare against the numbers in the changelog and
`docs/FALSE-POSITIVES.md`:

```bash
npx vitest run test/detection/accuracy.eval.test.ts \
  --disable-console-intercept --reporter=verbose   # precision, recall, per-category
npm run fpr                                        # FPR and the exact blocked rows
```

Compare **the rows, not just the totals**. An FPR that stays at 8.45% while the
twelve blocked rows change identity is a moved verdict wearing the same number.
If anything moved:

- say so explicitly, with the before and after
- cut `RULESET_VERSION` and the digest (`npm run ruleset:digest`)
- update `docs/FALSE-POSITIVES.md` and `test/eval/fpr.ts`, which the ruleset
  test pins to the current version
- run `npm run scorecard` and update what it feeds

Never adjust a threshold to restore a number a dependency moved. That hides the
change. Grow the corpus or accept the new measurement and record it.

## Majors need one more thing

Read the upstream changelog for behaviour changes, not just the version number,
and say in the PR body which ones you checked. A major that "just works"
because nothing in the suite exercises the changed path is the expensive kind
of green.

## Writing it up

`CHANGELOG.md` under `## [Unreleased]`. Say what a user gets, not what moved:
a version table is the diff, and the diff is already visible. If detection was
re-measured and did not move, **say that it was measured** and give the
numbers, because "no change" without a measurement behind it is an assumption.

## Stop here

Open the PR. Do not merge it, and do not merge Dependabot's own PRs on the
author's behalf. Report the gate result honestly, including anything skipped:
`npm run test:e2e` (Playwright, needs `npx playwright install chromium`) and
`npm run test:load` are not in the default gate and are worth running for a
`vitest` or `transformers` bump.
