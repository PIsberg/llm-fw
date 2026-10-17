# llm-fw Constitution

llm-fw is a local prompt-injection firewall for LLM traffic: a TypeScript proxy and gateway that
scan requests in flight and refuse the malicious ones. Node 22+, ESM, no framework.

## Core Principles

### I. The Gate Passes

`npx tsc --noEmit && npm run lint && npm run build && npm run test:run` MUST pass before a pull
request is opened. CI runs exactly these four, so a green local run of the full set is the real
signal. A gate that was skipped, unavailable or not run MUST be reported as such, never as passed.

Source: `CLAUDE.md`, `.claude/rules/testing.md`, `.github/workflows/ci.yml`.

### II. Test First, Observable Behaviour

Every behaviour change MUST ship with a vitest test in the existing suite and style, under
`test/`, which mirrors `src/`. The test MUST be seen failing before the fix where practical; when
it is not, the fix is broken once deliberately to confirm the test goes red. Tests assert what a
caller can observe, not internals. A change to the proxy pipeline MUST add a
`test/proxy/*.e2e.test.ts` case.

Source: `CLAUDE.md`, `.claude/rules/testing.md`.

### III. Grow the Corpus, Not the Thresholds

No detection threshold may move to make a test pass. A miss is closed by adding the example that
exposed it to `test/detection/fixtures/corpus.json`. A threshold that genuinely must move MUST be
stated in the pull request with measured before and after numbers. A change that can alter a
verdict MUST cut `RULESET_VERSION`.

Source: `CLAUDE.md`, `.claude/rules/detection.md`, `CONTRIBUTING.md`.

### IV. Security Boundaries Hold

- The proxy's auth check MUST run first in `handleConnect`, before any bypass.
- Token comparison MUST hash both sides and use a constant-time compare.
- Any response a module produces or replays from a cache MUST still pass the proxy's response-side
  gates, through `replayStoredResponse`, never written straight to the client.
- Detection MUST run once, on the complete buffered body.
- Prompt text, tool results, retrieved documents and credentials MUST NOT be logged.

Rationale: llm-fw is a security product; each of these has regressed or nearly regressed before,
and each is pinned by a test named in `.claude/rules/proxy-gateway.md`.

Source: `.claude/rules/proxy-gateway.md`, `CONTRIBUTING.md`.

### V. Config and Modules Are Complete

A new config key MUST land as all five edits: its type in `src/types.ts`, its default in
`DEFAULT_CONFIG`, an `ENV_OVERRIDES` entry when settable from the environment, a hot-reload
classification (warm, or listed as restart-required), and documentation, with the generated
environment table refreshed by `npm run config:reference`.

A new gateway module under `modules.<key>` MUST also add a `BUILTINS` entry in pipeline order, an
`LLM_FW_<KEY>_ENABLED` switch and warm options, MUST fail open, and MUST be off by default unless
it is read-only. A new runtime dependency MUST carry a stated reason: every dependency of a
security product is attack surface its users inherit.

Source: `.claude/rules/config.md`, `CLAUDE.md`, `CONTRIBUTING.md`.

### VI. Docs and Numbers Ship With the Change

Every change MUST update the documentation it makes wrong, in the same change, and add a
`## [Unreleased]` entry to `CHANGELOG.md`. Savings, accuracy and performance claims MUST carry
measured before and after numbers rather than adjectives. Text inside generated markers MUST NOT
be edited by hand; change the generator and regenerate.

Source: `CLAUDE.md`, `.claude/rules/docs.md`.

## Engineering Constraints

- TypeScript, strict and type-checked; pure ESM with no `require()` in `src/`; Node 22+.
- Structure is by domain (`src/detection/`, `src/proxy/`, `src/gateway/`, `src/config/`,
  `src/dashboard/`, `src/modules/`, `src/cli/`), and `test/` mirrors it.
- Configuration fails fast: an unparseable numeric environment variable throws `ConfigError`.
- Detailed, area-specific rules live in `.claude/rules/` and are indexed from `CLAUDE.md`.

## Development Workflow

- Branch first. Nothing is committed to `main`.
- Open the pull request; do not merge it. Merging, tagging and publishing are the maintainer's
  call.
- Commit messages and pull request bodies state the failure the change prevents and how it was
  verified.

Source: `CLAUDE.md`.

## Governance

This constitution supersedes conflicting practice for work planned through Spec Kit. Only the
maintainer amends it. An amendment states what changed and why, and bumps the version: MAJOR for
a removed or redefined principle, MINOR for a new principle or section, PATCH for wording. Every
spec, plan and review checks compliance with the principles above; `CLAUDE.md` and
`.claude/rules/` hold the detailed runtime guidance and win on detail where they are more
specific.

**Version**: 1.0.0 | **Ratified**: 2026-10-17 | **Last Amended**: 2026-10-17
