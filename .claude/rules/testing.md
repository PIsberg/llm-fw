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
not run them: `npm run test:e2e` (Playwright, dashboard UI) and `npm run
test:load` (performance and accuracy).

Not in CI: `npm run knip` (unused exports and dependencies), `npm run mutation`
(Stryker). Worth running when restructuring or removing code.

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
