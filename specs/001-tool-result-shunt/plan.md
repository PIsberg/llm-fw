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

**Storage**: stored originals and remembered outcomes as files under `getLlmFwDir()` (data-model.md
"Stored original"); outcomes also in memory, read back from disk after a restart, dropped after a
retention period uncarried (D9).

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
   is filled while screening: every scan item the pipeline reaches (`Pipeline.run` meta
   `onItemScanned`, T010), scan items with a warn outcome or a pending async-judge verdict
   (`onItemFlag`, T010), DLP findings, MCP tool-result audits, and an "incomplete" mark when the
   scan did not judge every item (fail-open pipeline error, or `result.enforced === false`, an
   observe-mode block that ended the scan). A tool result the scan never reached counts as flagged
   (FR-012); the parser is not extended (no verdict changes). Attribution rules: data-model.md
   "Screening record".
3. **One decision per distinct result (FR-006, FR-008).** Key `sha256(toolName \0 text)`, kept in
   memory while carried and on disk beside the stored originals, read back on a miss (D9); requests
   carrying the same key at once share one decision. All new results of a
   request go to the worker at once under one deadline, `start + waitMs`; anything unanswered then is
   aborted and remembered whole as `worker-failed`. Data-model.md "Remembered outcome".
4. **Condensed result and worker call**: `contracts/interfaces.md` sections 1 to 4. A worker that
   reports reading less than it was sent gives `worker-failed` (D12).
5. **Stored originals and outcome files (FR-021 to FR-025, D9)**: data-model.md "Stored original".
   The sweep runs from `src/cli/start.ts` at start and hourly, whether or not the module is on
   (`startShuntSweep`, T013, T014); the dashboard route deletes all (T020).
6. **Observe mode (FR-015)**: the worker is still asked so the card can count the saving; nothing is
   written or touched on disk (outcome files may be read). The added wait is bounded by `waitMs` as
   in enforce mode.
7. **Logging (FR-007, FR-011, FR-023, FR-024)**: one warning per distinct problem (no worker, worker
   not local, worker error, worker read part of the input, store not restricted, store write failed,
   store full, write-back failed), repeated only after the problem changes, never with text. "Checked when it is set"
   (FR-011) means at first use after the value changes: the module reads the live config object.
8. **FR-012 over FR-006**: a remembered condensed result whose own slot detection flags on a later
   request (Screening `flagged`, for example after a detection setting or suppression change) is
   forwarded whole from then on, its stored original deleted and its outcome file rewritten
   (D11); a slot the scan did not reach counts as such a flag. A flag the
   record cannot place on a slot (`all`: an incomplete scan, a DLP match outside any text slot such
   as a tool call's input) and a missing record keep only results not yet decided whole; a
   remembered outcome stays as it is (FR-006), so earlier turns never change because of one. Under
   `all` an unscanned slot is expected and is not counted.
9. **Measurement (US5)**: T000 measured the ceiling from local transcripts before Phase 1 (D10: go);
   then `test/eval/shunt/replay.ts` (free) and `test/eval/shunt/compare.ts`
   (billed, refuses to run without `--approve-spend`), both on a scratch `LLM_FW_DIR` (FR-020); how
   to run them is in quickstart.md.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* Result: PASS, no
violations, re-checked after the audit-3 revision.

| Rule | Tasks | How |
| --- | --- | --- |
| I. Gate passes before PR; skipped gates reported | spec-gatekeeper | it runs the four commands; the team process gives the full run no task |
| II. Behaviour ships with a test, seen failing first, observable behaviour | T001, T003, T005, T007, T009, T011, T013, T015, T017, T019, T021, T023, T025, T027 | every implementation task follows its failing tests |
| II. Proxy pipeline change adds a `test/proxy/*.e2e.test.ts` case | T013 | probe module case in `test/proxy/proxy.e2e.test.ts` |
| IV. Detection runs once, on the complete buffered body | T010, T014, T017 | shunt runs after the single `pipeline.run`; T017 asserts one run per request |
| IV. Tool results and prompt text never logged | T006, T008, T014, T016, T023 | worker and store problems warn with counts only; marker test on events, card, logs; traffic event body unchanged |
| V. Config key as five edits, env table regenerated | T002, T029 | type, default, `ENV_OVERRIDES`, `HOT_PATHS`, docs; `npm run config:reference` in T002 |
| V. Module: `BUILTINS` entry, `LLM_FW_<KEY>_ENABLED`, warm options, off by default, fails open | T002, T012, T016, T028 | `test/modules/builtins.test.ts` walks `BUILTINS`; worker and store failures forward whole |
| VI. Docs the change makes wrong, `## [Unreleased]` entry | T020, T029 | dashboard modules blurb (T020); token-savings guide's "runs before DLP and detection" and "byte-identical, never on time" guarantees, module section, configuration guide, CHANGELOG (T029) |
| VI. Savings claims carry measured numbers | T021, T022, T030 | replay harness, then measured numbers in the guide |
| VI. Generated markers not hand-edited | T002 | env table via `npm run config:reference` |
| Engineering: strict TS, ESM, domain structure, `test/` mirrors `src/` | all implementation tasks | new code under `src/modules/`, tests under `test/modules/` |
| Do not apply | none | III: no threshold or verdict change (T010 adds two callbacks, the parser is untouched; T002, T010 only re-pin `RULESET_DIGEST`, as PR #370 did). IV auth-first, constant-time compare: untouched. IV `replayStoredResponse`: the module makes no response. V new dependency: none. ConfigError: no numeric env var. Workflow: main session's |

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
src/modules/shuntStore.ts                new: stored originals and outcome files
src/modules/types.ts, registry.ts        post-screening pass
src/detection/pipeline.ts, ruleset.ts    onItemFlag, onItemScanned, digest re-pin
src/proxy/proxy.ts, src/gateway/gateway.ts, src/cli/start.ts, src/dashboard/server.ts
src/types.ts, src/config/config.ts, src/config/hotReload.ts
test/modules/{toolResultShunt,screening,shuntWorker,shuntStore}.test.ts, fixtures/fakeWorker.ts
test/detection/pipeline-item-flag.test.ts
test/cli/start-shunt.test.ts             new: sweep wiring in start.ts
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

### D9. When may the module forget a remembered outcome? (FR-006, FR-024)

**Decided: C** (maintainer, 2026-10-17, after audit 3). A was chosen first; audit 3 showed its cost
is not only a cold prompt cache: a model with preserved thinking answers 400 when an earlier prefix
changes, so a restart or a long idle would break every history-resending conversation holding a
condensed result. A's Spec lines are in spec.md; C's below replace them.

A forgotten outcome is decided again when its result comes back, so a condensation can be reworded
and a once-flagged result condensed. The maintainer ruled out the LRU of 4,096 (an evicted entry
of a live conversation was re-decided).

- **A: keep while carried, in memory only.** No entry cap; every carry sets `carriedAt`; at most
  once an hour `prepare` drops outcomes not carried for `retentionHours` (default 24 h); `flagged`
  outcomes are kept until restart. Follows: a restart, or an idle longer than the retention period,
  rewords condensations, and a model with preserved thinking refuses the next request of each such
  conversation.
- **B: keep every outcome until restart.** No cap and no prune. Follows: memory grows with every
  distinct eligible result until a restart; a restart rewords as under A.
- **C (chosen): A, plus every outcome kept on disk beside the stored originals and read back on a
  miss.** Memory as under A (about 3 MB for 1,000 distinct large results a day, estimated). On disk,
  `<key>.outcome` holds the condensed text or the decision to forward whole (data-model.md "Stored
  original"), written after each decision outside dry run, under the same cap, sweep, purge and
  FR-023 check as the originals, touched and written back with them on every carry (FR-024).
  Follows: a restart keeps every outcome a request carried within the retention period, so the
  wording and the history's shape survive it; an idle longer than the retention period still
  rewords, and the guide says so (T029). An outcome that cannot be written (store full, folder not
  restricted, write failed) lives in memory only and is lost at a restart. A `flagged` outcome's
  file holds the decision, never the text (FR-012). One disk read per eligible result not in
  memory. The files count against the store cap: a few dozen bytes per whole outcome, the
  condensation's length per condensed one. Tasks: T007, T008 (outcome files), T015 (restart,
  retention), T016 (write, read back), T017, T018 (`flagged`, the flip of D11), T019 (purge),
  T023, T024 (`storedFiles` counts originals only), T027, T028 (touch, write-back), T029 (guide).
  Spec: FR-006: "For a given original result, the module MUST produce the same output on every request that carries it, across restarts, for as long as a request carries the result at least once per retention period: the same condensed text, including the same stored original path, or the same decision to forward whole. The module MUST keep each remembered outcome on disk in the stored-originals folder, under the access rule of FR-023, the retention and write-back of FR-024 and the removal, cap and deletion on demand of FR-025, and read it back when it does not hold it in memory; an outcome it cannot write is kept in memory only. A result forwarded whole because the detection flagged it or did not scan it MUST stay whole until a restart, and after one for as long as its outcome is kept on disk. The output MUST depend only on that result and its tool call, never on the length of the conversation or on a retry. The worker MUST be asked at most once for each distinct original result while its outcome is remembered, including when several requests carry it at the same time."
  Spec: FR-014: "The module MUST NOT write tool output, condensed text or worker prompts to logs, events, the dashboard or any file it creates, with two exceptions: the stored original of FR-021, which holds the original result's text and nothing else, and the remembered outcome kept on disk (FR-006), which holds the condensed text or the decision to forward whole and nothing else. Views that show request content with the module off show the same content with it on."
  Spec: US4-6: replace "and on disk the marker appears only in the stored original" with "and on disk the marker appears only in the stored original and, when the condensed text quotes it, in the remembered outcome kept beside it".
  Spec: Edge Cases (restart): "The firewall restarts in the middle of a conversation: every remembered outcome kept on disk is read back, so the result keeps its wording and its stored file's path. An outcome that could not be written to disk (store full, folder not restricted, write failed) is lost, and its result may come back worded differently. The documentation says so."
  Spec: Assumptions: "Remembered outcomes are kept in memory and on disk beside the stored originals, so they outlive a restart. A retention period in which no request carries the result loses the outcome, except that a result forwarded whole because the detection flagged it or did not scan it stays whole in memory until a restart. A lost condensation can come back worded differently, and the documentation says so. Stored originals outlive a restart and are reused at the same path."
  Spec: Clarifications (D9): "- Q: How long is a remembered outcome kept (plan D9)? → A: In memory and on disk beside the stored originals, across restarts, while a request carries the result at least once per retention period (option C, chosen after audit 3: models with preserved thinking refuse a request whose earlier turns changed). A retention period in which no request carries the result loses the outcome; a result forwarded whole because the detection flagged it or did not scan it stays whole in memory until a restart. FR-006, FR-014, US4-6, the restart edge case and the Assumptions say so."

### D10. Measure the savings ceiling before building?

**Decided: go** (maintainer, 2026-10-17, on T000's result, recorded in tasks.md T000). T000 was
added as the first task by the user (2026-10-17); no FR requires it. Earlier modules moved billed
cost by under 1%, the truncator aside (-5.7%, with 24% more turns), and real command output was
about 10% of the tokens an earlier module cut (`.specify/projects/llm-fw/token-savings-findings.md`).
The T000 script is not committed, so its figures cannot be rerun from the repo; T022's replay
harness is the committed measurement (Design 9).

### D11. A later flag on a result already condensed (FR-006, FR-012; audit 3 M1)

**Decided: FR-012 first** (maintainer, 2026-10-17, audit 3 M1: state the precedence in the spec,
handle the stored file and the kept outcome). When a request puts the slot of a remembered
condensed result in `flagged` (plan Design 8), that request and every later one forward it whole:
its outcome becomes `flagged` in memory and in its outcome file, and its stored original is
deleted, so no flagged text stays in the folder (FR-012, SC-009). A flag the record cannot place
(`all`, no record) changes nothing (Design 8). In dry run only memory changes. Follows: that
conversation's history changes shape once, so its prompt cache misses and a model with preserved
thinking may refuse that one request; the guide says so. Another remembered condensed result with
the same text under a different tool name finds the file gone and writes it back (FR-024). Tasks:
T017, T018, T029.
  Spec: FR-012: append "This takes precedence over FR-006: a result condensed on an earlier request is forwarded whole from the first request on which the detection flags it or does not scan it, and its stored original is deleted. The module may keep on disk the decision to forward a flagged result whole (FR-006), never its text."
  Spec: FR-018: append "It MUST also say that a result condensed earlier is forwarded whole from the first request on which the detection flags it, which changes that conversation's history once."
  Spec: Edge Cases: add "A result condensed on an earlier request is flagged by the detection on a later one (after a detection setting or suppression change): it is forwarded whole from then on and its stored original is deleted. The conversation's history changes once, and the documentation says so."

### D12. A worker that read only part of the result (FR-007, FR-010; audit 3 M5)

**Decided: forward whole** (maintainer, 2026-10-17, audit 3 M5). The whole numbered original goes
to the worker, whose context window may be smaller. Verified on this machine on 2026-10-17 (Ollama
0.31.1, `qwen2.5:0.5b`, `/v1/chat/completions`, inputs of 60 to 4,000 numbered test-failure
lines): with the 4,096-token window Ollama picked, every input past the window was cut silently to
2,050 prompt tokens with status 200; a server started with `OLLAMA_CONTEXT_LENGTH=16384` reported
4,401 and 13,566 for the 140- and 400-line inputs the 4,096 window had cut; a repeated or same-prefix input reported its full count
(3,044, 3,044, 3,045), so prompt caching does not lower it. The check (contracts section 3):
`usage.prompt_tokens` absent or below `0.8 × (estimateTokens(WORKER_INSTRUCTIONS) +
estimateTokens(numberLines(original)))` gives `worker-failed` with problem `partial-input`, warned
once with both counts. The 0.8: `qwen2.5` counted 1.30 to 1.42 times `estimateTokens` on those
inputs (1,798 against 1,383 at 60 lines; 13,566 against 9,528 at 400), so an input Ollama halves
reports at most 0.71 of the estimate. The check catches that cut for a worker tokenizer counting
under 1.6 times the estimate, and forwards an uncut input whole only for one counting under 0.8
times it; measured on one kind of output only. Tasks: T005, T006, T015, T029; quickstart.md
section 1.
  Spec: FR-007: append "A worker that reports reading less of the result than it was sent counts as failing."
  Spec: FR-018: append "It MUST also say how to give the worker a context window that holds the largest result it is sent, and that a result the worker reports reading only in part is forwarded whole."

### D13. Default `maxInputChars` against the worker's context window (D12)

**Decided: A** (maintainer, 2026-10-17).

Keep the largest result sent to the worker at 200,000 characters, or lower the default to what a
32,768-token window holds (about 55,000 characters at the 0.45 tokens per character measured in
D12)? No FR sets this default (FR-002 names only "the worker's allowed input").

- **A (recommended): keep 200,000.** No change. Follows: T000's ceiling, measured at 200,000, stays
  the basis. With the quickstart's `qwen2.5:3b` (a 32,768-token window at most) a new result over
  about 55,000 characters is sent, cut, and forwarded whole as `worker-failed` with a
  `partial-input` warning, adding the worker's time (at most `waitMs`, 15 s) to that request once
  per distinct result; the guide tells operators to lower `maxInputChars` to their window (T029).
- **B: lower the default to 55,000.** Follows: larger results are `too-large`, with no worker call
  and no wait; an operator with a larger window raises it; fewer of the largest results are
  condensed, by a share not measured (T000 did not split its 203 results by size). T001, T002 and
  data-model.md "Config" change the default; no spec line changes.
