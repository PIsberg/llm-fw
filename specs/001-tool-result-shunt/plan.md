# Implementation Plan: Tool Result Shunt

**Branch**: `001-tool-result-shunt` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-tool-result-shunt/spec.md`

## Summary

A new opt-in gateway module, `modules.toolResultShunt` (id `tool-result-shunt`), replaces large
command output in tool results with a condensation written by a worker model the operator runs on
the same machine, and stores the exact original in `<LLM_FW_DIR>/tool-results/<sha256>.txt` for the
agent to read back. Unlike every existing module it runs **after** DLP and detection, so the
firewall decides on the original and never scans condensed text (FR-012). The feature also ships
the two measurement harnesses of User Story 5.

## Technical Context

**Language/Version**: TypeScript (strict), ESM, Node 22+

**Primary Dependencies**: none new. The worker is called with `fetch`. The measurement harness
counts tokens with `Xenova/gpt-4o` (o200k) through `AutoTokenizer` from `@huggingface/transformers`,
already a dependency and the tokenizer `test/modules/tokens.test.ts` was calibrated against;
Claude's tokenizer is not public (FR-019).

**Storage**: stored originals as files under `getLlmFwDir()` (data-model.md); remembered outcomes in
memory only, lost on restart (spec Assumptions).

**Testing**: vitest. Unit tests under `test/modules/`, `test/detection/`, `test/dashboard/`,
`test/eval/`; e2e in `test/proxy/proxy.e2e.test.ts` and `test/gateway/*.e2e.test.ts`. The worker in
tests is a loopback HTTP stand-in (`test/modules/fixtures/fakeWorker.ts`, T005).

**Target Platform**: the proxy and the gateway on Windows, macOS and Linux.

**Project Type**: single TypeScript project (proxy, gateway, dashboard, CLI).

**Performance Goals**: under 5 ms median added to a request with no eligible result (SC-005); at
most `waitMs` (default 15 s) added to any request (FR-008).

**Constraints**: the worker URL must be loopback, checked before every send, redirects refused
(FR-011); no tool output in any log, event or card (FR-014).

**Scale/Scope**: one firewall process; store capped at 200 MB by default (FR-025).

No `NEEDS CLARIFICATION` remains: the spec has no markers, and every choice the spec leaves open is
either settled below or listed under Decisions. No `research.md`: the two technology choices
(tokenizer above, worker API in D4) are recorded here.

## Design

1. **Placement (FR-012).** `GatewayModule` gains `afterScreening`; `ModuleManager.transformRequest`
   skips such modules and a new `ModuleManager.transformScreened` runs only them (T011, T012). The
   proxy calls it in `handleRequest` just before `this.modules.respond`, the gateway in `handle`
   right after `screen` (T014). DLP, the pipeline, the MCP checks, taint, loop detection and the
   traffic event all see the body as it is with the module off; `respond`, the upstream write and
   `observeResponse` get the shunted body. Observe mode (proxy `enforcement`, gateway per tenant)
   forwards the screened body.
2. **What detection flagged (FR-012, D1).** A per-request `Screening` record (`src/modules/screening.ts`)
   is filled while screening: scan items with a warn outcome or a pending async-judge verdict
   (`Pipeline.run` meta `onItemFlag`, T010), DLP findings, MCP tool-result audits, and an
   "incomplete" mark when the scan did not judge every item (fail-open pipeline error, or
   `result.enforced === false`, an observe-mode block that ended the scan). Attribution rules:
   data-model.md "Screening record".
3. **One decision per distinct result (FR-006, FR-008).** Key `sha256(toolName \0 text)`, kept in an
   LRU of 4,096 like `LeanCtxModule.decided` (`src/modules/builtin/leanCtx.ts`). All new results of a
   request go to the worker at once under one deadline, `start + waitMs`; anything unanswered then is
   aborted and remembered whole as `worker-failed`.
4. **Condensed result and worker call**: `contracts/interfaces.md` sections 1 to 4.
5. **Stored originals (FR-021 to FR-025)**: data-model.md "Stored original". The sweep runs from
   `src/cli/start.ts` at start and hourly, whether or not the module is on (T014); the dashboard
   route deletes all (T020).
6. **Observe mode (FR-015)**: the worker is still asked so the card can count the saving; nothing is
   written or touched on disk. The added wait is bounded by `waitMs` as in enforce mode.
7. **Logging (FR-007, FR-011, FR-023, FR-024)**: one warning per distinct problem (no worker, worker
   not local, worker error, store not restricted, store write failed, store full, write-back
   failed), repeated only after the problem changes, never with text. "Checked when it is set"
   (FR-011) means at first use after the value changes: the module reads the live config object.
8. **FR-012 over FR-006**: a remembered condensed result that detection flags on a later request is
   forwarded whole from then on. Only a detection setting or suppression change mid-conversation
   can cause it.
9. **Measurement (US5)**: `test/eval/shunt/replay.ts` (free) and `test/eval/shunt/compare.ts`
   (billed, refuses to run without `--approve-spend`), both on a scratch `LLM_FW_DIR` (FR-020); how
   to run them is in quickstart.md.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* Result: PASS, no
violations, re-checked after design.

| Rule | Tasks | How |
| --- | --- | --- |
| I. Gate passes before PR; skipped gates reported | spec-gatekeeper | it runs the four commands; the team process gives the full run no task |
| II. Behaviour ships with a test, seen failing first, observable behaviour | T001, T003, T005, T007, T009, T011, T013, T015, T017, T019, T021, T023, T025, T027 | every implementation task follows its failing tests |
| II. Proxy pipeline change adds a `test/proxy/*.e2e.test.ts` case | T013 | probe module case in `test/proxy/proxy.e2e.test.ts` |
| IV. Detection runs once, on the complete buffered body | T010, T014, T017 | shunt runs after the single `pipeline.run`; T017 asserts one run per request |
| IV. Tool results and prompt text never logged | T016, T023, T014 | warn-once lines carry no text; marker test on events, card, logs; traffic event body unchanged |
| V. Config key as five edits, env table regenerated | T002, T029 | type, default, `ENV_OVERRIDES`, `HOT_PATHS`, docs; `npm run config:reference` in T002 |
| V. Module: `BUILTINS` entry, `LLM_FW_<KEY>_ENABLED`, warm options, off by default, fails open | T002, T012, T016, T028 | `test/modules/builtins.test.ts` walks `BUILTINS`; worker and store failures forward whole |
| VI. Docs the change makes wrong, `## [Unreleased]` entry | T029 | token-savings guide (incl. the "runs before DLP and detection" guarantee), configuration guide, CHANGELOG |
| VI. Savings claims carry measured numbers | T021, T022, T030 | replay harness, then measured numbers in the guide |
| VI. Generated markers not hand-edited | T002 | env table via `npm run config:reference` |
| Engineering: strict TS, ESM, domain structure, `test/` mirrors `src/` | all implementation tasks | new code under `src/modules/`, tests under `test/modules/` |
| Do not apply | none | III: no threshold or verdict change (T010 adds a callback; T002, T010 only re-pin `RULESET_DIGEST`, as PR #370 did). IV auth-first, constant-time compare: untouched. IV `replayStoredResponse`: the module makes no response. V new dependency: none. ConfigError: no numeric env var. Workflow: main session's |

## Project Structure

### Documentation (this feature)

```text
specs/001-tool-result-shunt/
├── plan.md              # this file
├── data-model.md        # config, eligibility, screening record, stored original, counters
├── contracts/
│   └── interfaces.md    # condensed result, citation rules, worker request, dashboard route
├── quickstart.md        # hand-run checks: replay, billed comparison, docs check
└── tasks.md
```

### Source Code (repository root)

```text
src/modules/builtin/toolResultShunt.ts   new: the module
src/modules/screening.ts                 new: Screening record
src/modules/shuntWorker.ts               new: worker client, condensed result, citation check
src/modules/shuntStore.ts                new: stored originals
src/modules/types.ts, registry.ts        post-screening pass
src/detection/pipeline.ts, ruleset.ts    onItemFlag, digest re-pin
src/proxy/proxy.ts, src/gateway/gateway.ts, src/cli/start.ts, src/dashboard/server.ts
src/types.ts, src/config/config.ts, src/config/hotReload.ts
test/modules/{toolResultShunt,screening,shuntWorker,shuntStore}.test.ts, fixtures/fakeWorker.ts
test/detection/pipeline-item-flag.test.ts
test/gateway/gateway-shunt.e2e.test.ts   new, port 18231
test/eval/shunt/{replay.ts,compare.ts,compare-tasks.json,fixtures/}, test/eval/shunt{Replay,Compare}.test.ts
docs/guides/token-savings.md, docs/guides/configuration.md, CHANGELOG.md, package.json
```

**Structure Decision**: single project; the module and its helpers live in `src/modules/` beside
`leanCtx.ts`, the reference module for shape (BUILTINS entry, config, tests, guide section).

## Complexity Tracking

None.

## Decisions

### D1. How does the module learn which results detection flagged? (FR-012, US6-3)

**Decided: A** (maintainer, 2026-10-17).

- **A (recommended): per result.** T009/T010 add `onItemFlag?: (text: string) => void` to
  `Pipeline.run`'s meta (three call sites in `src/detection/pipeline.ts`: item-cache hit with a
  warn, the per-item merge, the async-judge dispatch). The Screening record (T003/T004) places DLP
  findings by match and MCP audits by call id; anything it cannot place flags every new result of
  that request. Follows: US6-3 holds as written. `pipeline.ts` changes, so the digest is re-pinned
  in T010; no `RULESET_VERSION` cut, and no `npm run verdicts:dump`/`verdicts:diff` run is planned
  (the owner can add it to T010 as evidence of 0 changed verdicts). A secret that DLP finds outside
  any text slot (for example in a tool call's arguments) flags the whole request, so a
  history-resending conversation carrying it condenses nothing new. Suspicious items handed to the
  asynchronous judge count as flagged, because its verdict comes after forwarding.
- **B: per request.** Any warn, DLP finding, MCP audit or incomplete scan flags every new eligible
  result in the request. Follows: no change under `src/detection/` (T009 and T010 dropped, T004
  shrinks to one boolean); for a client that resends its history a flagged result recurs in every
  later request, so the module condenses nothing new for the rest of that conversation. With DLP
  in its default redact mode, one secret in one tool result does that.
  Spec: US6-3: "**Given** observe mode or enforce mode, **When** a request carries one flagged eligible result and one eligible result the detection does not flag, **Then** both are forwarded whole, and every result first seen in a request that carries a flagged result stays whole on later requests."

### D2. What FR-014 and US4-6 cover

**Decided: A** (maintainer, 2026-10-17).

- **A (recommended): what the module writes.** The module puts no tool output, condensed text or
  worker prompt in its log lines, events or card, and no surface shows condensed text. Surfaces
  that show tool output with the module off keep doing so: the traffic event's `requestBody` (first
  16 KB of the screened body, `TRAFFIC_BODY_CAP` in `src/proxy/proxy.ts`) and MCP tool-result
  events (`payload_full: tr.result`, MCP on by default). T014 keeps the screened body on the traffic
  event; T023 tests the marker against the module's events, card and logs.
  Spec: FR-014: "The module MUST NOT write tool output, condensed text or worker prompts to logs, events, the dashboard or any file it creates, with one exception: the stored original of FR-021, which holds the original result's text and nothing else. Views that show request content with the module off show the same content with it on."
  Spec: US4-6: "**Given** tool output containing a recognisable marker string has been condensed, **When** the module's log lines, its live events and its dashboard card are searched, **Then** the marker appears in none of them, no view shows the condensed text, views that showed the tool output with the module off (the traffic inspector, MCP events) are unchanged, and on disk the marker appears only in the stored original."
- **B: every surface.** Also strip tool output from traffic and MCP events. Follows: a behaviour
  change for every request with the module on or off (the traffic inspector loses tool results), an
  extra task on `src/proxy/proxy.ts`, `src/gateway/gateway.ts` and the dashboard views, and its own
  CHANGELOG line; US4-6 holds as written.

### D3. What "the exact original" is when an earlier module rewrote the result (FR-021, FR-013, US2-4)

**Decided: A** (maintainer, 2026-10-17).

- **A (recommended): the text the shunt receives**, after the modules that run before detection
  and after DLP. Follows: with every other module off (the default) it is what the agent sent. With
  the truncator on, a result it cut is stored cut, so "complete" is false for it; a truncated
  result keeps 300 lines but can still pass 20,000 characters. DLP-redacted results are flagged and
  never stored.
  Spec: FR-021: append "The original is the result's text as the module receives it, after any module that runs before detection; with such a module on, the stored file holds that module's output."
- **B: the text the agent sent.** Follows: the pre-module body has to reach the module and each slot
  has to be matched to its pre-module slot by content (the history window drops turns); more code in
  T014 and T016; detection then judged a text different from the stored one.

### D4. Which worker API the module speaks

**Decided: A** (maintainer, 2026-10-17).

- **A (recommended): OpenAI-compatible `POST {workerUrl}/v1/chat/completions`** (contracts section 3),
  served by Ollama, llama.cpp's server, LM Studio and vLLM; token counts from `usage`.
- **B: Ollama's `/api/chat`**, like `JudgeClient` (`src/detection/judge.ts`). Follows: Ollama only;
  counts from `prompt_eval_count`/`eval_count`; T005/T006 change shape.

### D5. Who besides the running account may read stored originals on Windows (FR-023, US7-2)

**Decided: A** (maintainer, 2026-10-17).

- **A (recommended): the running user and SYSTEM**, through `restrictDirPermissions`
  (`src/proxy/certs.ts`), as for the CA key; the confirmation is icacls exiting 0, and an unset
  `USERNAME` counts as not restricted. Follows: OS services running as SYSTEM keep access, as they
  have to `ca.key`.
  Spec: FR-023: "The stored-originals folder and every file in it MUST be readable and writable only by the operating-system account that runs the firewall (on Windows, and SYSTEM, as for the firewall's CA key)."
  Spec: US7-2: "**Given** a stored original, **When** an operating-system account other than the one running the firewall (on Windows, other than SYSTEM) tries to list the folder or read the file, **Then** access is denied."
- **B: the running user only.** Follows: a second icacls grant without SYSTEM and a confirmation that
  parses the ACL by SID, since icacls output is localised; one more code path in T008; services
  running as SYSTEM can still read through backup privileges.

### D6. Where SC-002's labelled key facts come from

**Decided: A** (maintainer, 2026-10-17).

- **A (recommended): a rule-based extractor** (`extractKeyFacts` in T022) that pulls failing test
  names (vitest, jest, pytest, go test, cargo), error lines, the exit status and summary-count
  lines from the original. The labelled subset is the condensed results where it finds at least one
  fact; retention is the share found verbatim (whitespace-normalised) in the condensed result.
  Follows: repeatable and free; formats it does not know are not measured; the report gives the
  subset size and says so when it is under 50.
  Spec: SC-002: "On a subset of at least 50 condensed results whose key facts (failing test names, error messages, final status, summary counts) a rule-based extractor finds in the original, at least 90% of those facts appear in the condensed result."
- **B: the maintainer labels 50 results by hand.** Follows: a labels-file format and a manual pass
  before T030, repeated for every new sample.

### D7. Run the billed comparison stage in this feature? (US5-3, SC-007)

**Decided: A** (maintainer, 2026-10-17).

- **A (recommended): no.** T025/T026 ship the harness; it refuses to spawn without
  `--approve-spend`; T030 writes that the comparison was not run (US5-4). Follows: SC-007 is
  unverified at merge.
- **B: yes.** Follows: a task T031 after T030 runs at least 4 tasks in both arms through `claude -p`
  on a paid model against another repository in enforce mode (spec Assumptions) and adds the
  results to the guide; the cost has not been estimated.

### D8. Shell commands that print files (`cat`, `sed`, `Get-Content` through a shell tool)

**Decided: A** (maintainer, 2026-10-17).

- **A (recommended): no special handling.** No FR requires it, and the stored original gives the
  exact text back. Follows: such results are condensed like any command output.
- **B: treat them as file reads**, reusing `isFileRead(command, skipCommands)`
  (`src/modules/builtin/leanCtx.ts`) with a new warm option `skipCommands`. Follows: one more config
  key (T002, T029), an `excluded-tool` path in T016, less saving (shell `sed`/`cat`/`awk` were
  19.4% of the tokens an earlier module cut).
  Spec: FR-002: "...its tool is not excluded, it is not a ranged file read, it is not a shell command that prints a file, it is at or above the size threshold, ..."
  Spec: FR-003: append "Shell commands that print a file (cat, sed, Get-Content and the like) count as file reads."
