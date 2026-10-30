# Rule: testing

Read when adding or changing tests, or before claiming work is done.

## The gate

CI runs these four, in this order, and so should you:

```bash
npx tsc --noEmit
npm run lint
npm run build
npm run test:run
```

`npm run test:run` is two suites: `vitest run` (unit, integration, and the
detection accuracy regression) and `vitest run --config vitest.e2e.config.ts`
(the proxy end-to-end suite). Both must pass.

Also in CI, not required locally before a PR, but say so in the PR if you did
not run them:

| Command | Job | Gates |
| --- | --- | --- |
| `docker build` + run | Docker Image (`docker.yml`), on PRs touching `Dockerfile`, `docker/**`, `package*.json` or `data/**` | The image builds, runs a Node major the CI matrix tests, and its gateway reports `/readyz`. Needs a Docker daemon locally |
| `npm run test:e2e` | E2E Tests | Playwright, dashboard UI. Needs `npx playwright install chromium` first. |
| `npx vitest run test/cli/` on `windows-latest` | CLI on Windows | Windows-only CLI behaviour (`it.runIf(win32)` cases, Task Scheduler round trip). Runs locally on a Windows machine |
| `npm run test:load:perf` | Load Tests | p99 latency ceiling |
| `npm run test:load:accuracy` | Load Tests | FPR ceiling, TPR floor, under concurrency |
| `npm run scorecard` | Load Tests | deterministic sweep, per-class recall |
| `npm run test:judge` | Stage 3 Judge (`judge.yml`), nightly and on PRs touching the judge | Stage 3 coverage: each `stage3-corpus.json` prompt passes Stages 1 and 2 and the judge blocks it. Needs a running Ollama and fails without one (`LLM_FW_JUDGE_MODEL=qwen2.5:3b`) |
| `npm run fpr` | Load Tests | false-positive SLO on four HELD-OUT benign corpora: hand-written agent traffic, a 2,000-row Dolly-15k sample, a 2,000-row oasst1 sample of conversational user turns and a 2,795-row Aya sample of prompts in 70 languages. The full 15,011 rows run nightly, report-only (`--only=dolly-15k-full`) |
| `npm run recall:floor` | Load Tests | direct-injection recall: an absolute floor of blocked attacks per held-out split (gandalf, safeguard, deepset, heldout, jailbreak-classification), plus a ceiling on jailbreak-classification's benign rows, and a floor and benign ceiling on the identifier-free indirect-injection probe (#535), in `test/eval/lib/recallFloor.ts`; also prints recall on unseen rows |
| `npm run bench:compare` | Classifier Benchmark (`classifier-benchmark.yml`), weekly and on dispatch | the classifier preset over every split, compared with the published column in `test/eval/baselines/classifier.json`: recall within 2 points, FPR within 1 point, either way (#554). Re-measuring the BENCHMARK.md table means updating that file too |
| `npm run fuzz:rules` | Load Tests | mutation resilience: the corpus attacks the cheap pipeline blocks, reworded nine ways (homoglyphs, leetspeak, a polite opener, synonyms, no punctuation and more), must still block at the per-rewording floors in `test/eval/lib/mutations.ts` (#541) |

The last one is the half that is easy to forget. Recall has always been gated;
`fpr` is what catches a change that starts blocking real benign traffic, and it
fails on the FIRST false positive in any category that currently has none. If
you touched detection, run it. `recall:floor` is the same idea for recall
on the held-out direct-injection splits: the accuracy gate grades its own
corpus, and the nightly drift gate compares with a moving median, so 8 of 853
direct injections were lost a row or two at a time with both green (#480).

`npm run lint` runs ESLint (with `@typescript-eslint` and `eslint-plugin-sonarjs`),
Oxlint (`--deny-warnings`), and Biome (`--error-on-warnings`, linter only).
`npm run knip` (unused exports, files and dependencies) runs in CI on Node 22; its
exceptions for OS commands and the worker entry live in `knip.json`. Both also run
in `.githooks/pre-commit` alongside `npx tsc --noEmit`. Not in CI:
`npm run mutation` (Stryker, weekly on a schedule instead).

## Where a test goes

`test/` mirrors `src/`: `test/detection/`, `test/proxy/`, `test/gateway/`,
`test/cli/`, `test/config/`, `test/dashboard/`, `test/api/`, `test/license/`.

A behaviour change to the proxy pipeline itself generally needs an
`*.e2e.test.ts` case under `test/proxy/`. Those run serially on fixed ports;
see the "End-to-End (E2E) Proxy Tests" section of
[docs/TESTING.md](../../docs/TESTING.md) for how isolation works there.

## Standards

- **Failing test first** where practical, and show it failing. A test written
  after the fix proves the code runs, not that the test detects the bug. When
  going failing-first is impractical, break the fix deliberately once and
  confirm the test goes red.
- **Test observable behaviour**, not internals. A test pinned to implementation
  fails on every refactor and passes through real defects.
- **A bug fix without a regression test is not finished.** If you cannot write
  one, say why in the same message rather than skipping it quietly.
- **Never let a pipe eat an exit code.** `cmd | tee log` reports the last
  stage's status. Check the command directly, or use `PIPESTATUS`/`pipefail`.

## Reporting

Report skipped, unavailable and not-run distinctly from passed. Absence of
findings is never evidence of correctness. If a test fails, paste the failure.
