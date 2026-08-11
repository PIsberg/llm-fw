# Contributing to llm-fw

Thanks for taking the time to contribute. This document covers how to report
bugs (especially detection false positives/negatives), suggest features, and
get a pull request merged.

For how to install and run llm-fw day-to-day, see the [README](README.md).
This file is about working *on* the project, not *with* it.

## Table of Contents

- [Reporting bugs](#reporting-bugs)
- [Reporting a detection false positive or false negative](#reporting-a-detection-false-positive-or-false-negative)
- [Suggesting features](#suggesting-features)
- [Security vulnerabilities](#security-vulnerabilities)
- [Development environment](#development-environment)
- [Code style](#code-style)
- [Testing requirements](#testing-requirements)
- [Benchmark and regression expectations](#benchmark-and-regression-expectations)
- [Documentation expectations](#documentation-expectations)
- [Pull request process](#pull-request-process)
- [License of contributions](#license-of-contributions)

## Reporting bugs

Open a [GitHub issue](https://github.com/PIsberg/llm-fw/issues) with:

- The `llm-fw` version (`llm-fw --version`) and OS.
- How you're running it: installed CLI, from source, sinkhole mode, or
  standalone server mode.
- The exact command or config that triggers the problem.
- What you expected vs. what happened, including any relevant `llm-fw doctor`
  output or dashboard event.

## Reporting a detection false positive or false negative

Detection accuracy bugs are the most valuable reports this project gets, and
they need more than "it blocked something it shouldn't have." Include:

- **The prompt or tool output** that was mis-classified (redact anything
  sensitive, but keep the structure/wording that triggered the verdict).
- **Expected verdict** (allow/warn/block) vs. **actual verdict**.
- **Which stage flagged or missed it** — heuristic, embedding, classifier, or
  judge. The dashboard's expanded event detail (see the README's "Prompt
  Testing — stage-by-stage verdict" screenshot) shows this; paste it if you
  have it.
- **The surface** — `prompt`, `system`, `tool_result`, or `document` — since
  several defenses (e.g. the intent-vs-mention gate) are scoped per-surface.
- Any non-default config (`detection.*` thresholds, surface overrides).

If you can, add the example to `test/detection/fixtures/corpus.json` (attacks
under `"attacks"`, safe prompts under `"benign"`) and open the PR yourself —
see [Benchmark and regression expectations](#benchmark-and-regression-expectations).
That corpus is what `test/detection/accuracy.eval.test.ts` runs on every CI
build, so an entry there is a permanent regression test, not just a bug report.

## Suggesting features

For a new detection rule, provider, or defense mechanism, open an issue first
describing:

- The attack pattern or gap it closes (link to a paper, CVE, or real prompt if
  you have one), or the provider/integration it adds.
- Which stage it belongs in — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
  and the README's stage-by-stage breakdown (Heuristic → Embedding → Judge →
  output-side classifier) before proposing a new one.
- Whether it's on-by-default or opt-in. New defenses that can produce false
  positives on legitimate traffic generally ship opt-in first (see e.g.
  cross-request crescendo tracking or the output-side classifier), the same
  way past additions have.

Small, focused PRs for an isolated detector or provider adapter are easier to
review than one PR that changes several stages at once.

## Security vulnerabilities

llm-fw is a security tool, so a vulnerability in it (a bypass that lets a
crafted prompt evade every stage, a proxy/TLS interception flaw, an MCP
guardrail bypass, credential handling, etc.) is not a normal bug report.

**Do not open a public GitHub issue for a vulnerability.** Email
**peter.isberg@deversity.se** with:

- The bypass or vulnerability, with a reproducible example.
- Its impact (what a request could achieve that the firewall is supposed to
  stop).
- Whether you'd like credit in the release notes once it's fixed.

You'll get an acknowledgement, and a disclosure timeline will be worked out
with you before anything is made public.

## Development environment

Setup, running from source, sinkhole mode, and standalone server mode are all
covered in the README:

- [Prerequisites](README.md#prerequisites)
- [Running in development (from source)](README.md#running-in-development-from-source)
- [Sinkhole mode — for Node.js tools and native binaries](README.md#sinkhole-mode--for-nodejs-tools-and-native-binaries)
- [Standalone server mode](README.md#standalone-server-mode--one-firewall-for-many-clients)

Stage 3 (the local Ollama judge) is optional for most contributions — the
heuristic and embedding stages run without it, and the accuracy regression
gate runs the cheap pipeline (judge off) by default.

## Code style

- **TypeScript**, strict and type-checked. `src/**/*.ts` runs under
  `@typescript-eslint`'s `recommended` and `recommended-type-checked` rule
  sets (see `eslint.config.js`); `scripts/**/*.ts` runs the syntax-only subset.
- No unused vars (`_`-prefixed args are exempt), no floating promises, and
  `no-explicit-any` is a warning, not an error — avoid it where you
  reasonably can.
- There's no Prettier or other auto-formatter in this repo; match the
  formatting already present in the file you're editing.
- `npm run lint` (or `npm run lint:fix` for auto-fixable issues) must be clean
  before you open a PR.
- `npm run knip` finds unused exports/files/dependencies. Not part of CI yet,
  but worth running if you're removing or restructuring code.

## Testing requirements

Full details are in [`docs/TESTING.md`](docs/TESTING.md). In short:

- `npm run test:run` is the gate — it runs `vitest run` (unit, integration,
  and the detection accuracy regression suite) **and**
  `vitest run --config vitest.e2e.config.ts` (the proxy end-to-end suite).
  Both must pass; it's what CI runs on every PR.
- New detectors, parsers, or config options need unit/integration coverage
  under `test/`, following the existing layout (`test/detection/`,
  `test/proxy/`, `test/cli/`, etc.).
- A behavior change to the proxy pipeline itself generally needs an
  `*.e2e.test.ts` case under `test/proxy/` — see `docs/TESTING.md`'s
  "End-to-End (E2E) Proxy Tests" section for how isolation (fixed ports,
  serial execution) works there.
- `npm run test:e2e` (Playwright, dashboard UI) and the load tests
  (`npm run test:load`) run in CI; they're not required to pass locally before
  opening a PR, but say so explicitly in the PR rather than omitting them.

## Benchmark and regression expectations

- `test/detection/accuracy.eval.test.ts` runs the cheap pipeline (heuristic +
  embedding, judge off) against the labeled corpus in
  `test/detection/fixtures/corpus.json` and asserts precision ≥ 95%, overall
  recall ≥ 80%, and per-attack-category recall ≥ 60%. It's part of
  `npm run test:run`, so it already gates every PR.
- **Grow the corpus, not the thresholds.** If your change fixes a miss, add
  the example that exposed it to `corpus.json` rather than only fixing the
  one case you hit. If you believe a threshold itself needs to move, say so
  explicitly in the PR with the measured before/after — don't lower it
  silently to make a test pass.
- `npm run scorecard` regenerates the numbers behind the README's "Detection
  Scorecard" section and `docs/SCORECARD.md`. Run it and update both if your
  change measurably shifts detection accuracy (new detector, changed
  threshold, new corpus entries).
- `npm run bench:competitors` and the harness under `test/eval/competitors/`
  compare against third-party guardrails on the same held-out splits — useful
  context for a detection PR, not required to run for most contributions.

## Documentation expectations

Update whatever the change makes wrong, in the same PR — not as a follow-up:

- **README.md** — if you add a config key, CLI flag, or defense, document it
  where its siblings already are (the README is organized stage-by-stage and
  feature-by-feature; find the matching section rather than appending to the
  end).
- **CHANGELOG.md** — add an entry under `## [Unreleased]`, in [Keep a
  Changelog](https://keepachangelog.com/en/1.1.0/) format. Describe the
  change for a user (the failure it prevents, the flag that's now available),
  not the diff.
- **docs/*.md** — `docs/ARCHITECTURE.md`, `docs/TESTING.md`,
  `docs/BENCHMARK*.md`, etc. Update the one that describes what you changed;
  don't leave a stale example or a workaround comment for code that no longer
  exists.

## Pull request process

1. Fork and branch from `main`.
2. Make the change, with tests (see [Testing requirements](#testing-requirements)).
3. Run `npx tsc --noEmit`, `npm run lint`, `npm run build`, and
   `npm run test:run` locally — this is what CI runs, so a local pass here is
   the real signal.
4. Update the docs the change makes wrong (see above).
5. Open the PR against `main`. Describe *why* the change is needed and how you
   verified it; the diff already shows *what* changed.
6. Address review feedback and keep the PR green through CI. A maintainer
   merges once checks pass and the change is reviewed — please don't merge
   your own PR.

## License of contributions

llm-fw is distributed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md),
not a permissive open-source license — noncommercial use and modification are
allowed under its terms, but the copyright is held solely by Peter Isberg. By
submitting a pull request, you agree that your contribution may be
distributed as part of llm-fw under that same license (and any future license
the project moves to), the same as the existing codebase.
