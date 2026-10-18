# Handover: tool result shunt (#361)

For the next agent or contributor who finishes this feature. Written 2026-10-18 by the session that
ran `/speckit-team --project llm-fw` on #361. Read this, then `spec.md`, `plan.md` and `tasks.md` in
this folder, then `CLAUDE.md` and `.specify/projects/llm-fw/instructions.md`.

## Where it stands

- **Branch** `001-tool-result-shunt`, on top of `main` at 6d3630d. Opened on 2026-10-18 as draft
  PR #392 at the maintainer's request, before the Codex fix merged; the maintainer accepted that
  this discloses the gap described under "Depends on". The follow-up issues are #375 to #391. A copy
  also sits in the advisory's private fork `PIsberg/llm-fw-ghsa-83jp-cppw-c3v6` as a branch with no
  PR. Never open a PR for it there: GitHub merges only one PR into a temporary private fork's
  `main`, and a second one blocks merging the fix (PR #1 there).
- **Built:** all 31 tasks, T000 to T030, ticked. The `tool-result-shunt` gateway module
  (`src/modules/builtin/toolResultShunt.ts`, with `src/modules/screening.ts`, `shuntWorker.ts`,
  `shuntStore.ts`). Two new detection callbacks, `onItemScanned` and `onItemFlag`, in
  `src/detection/pipeline.ts`. `ModuleManager.transformScreened`, which runs `afterScreening`
  modules on the screened body. Proxy and gateway wiring, the start-up sweep (`src/cli/start.ts`),
  the purge route `POST /api/modules/tool-result-shunt/purge` and its dashboard button. The replay
  and comparison harnesses in `test/eval/shunt/`. Docs in `docs/guides/token-savings.md`,
  `docs/specs/SPEC-modules.md`, `docs/guides/configuration.md` and the CHANGELOG.
- **Gates at 7ec55c0**, run by the spec-gatekeeper on Node v26.8.2, Windows:
  - passed: `tsc`, lint and build;
  - passed: unit half (149 files, 2,943 passed, 4 skipped) and e2e half (25 files, 172 passed);
  - passed: Playwright (41), `docs:links`, `fpr` (0.00%), load perf (p99 41 ms) and load accuracy;
  - passed: `verdicts:diff`, 0 of 23,938 changed;
  - 22 deliberate breaks, each turning the targeted tests red.
  - Not run: Docker, Semgrep, CodeQL, and the billed comparison stage.
  - Skipped on Windows: three POSIX file-mode tests in `test/modules/shuntStore.test.ts`, which only
    CI's Linux run covers.
- **spec-gatekeeper verdict: REJECTED**, for two reasons. Both are open work, listed below:
  - FR-018 doc gaps;
  - SC-002, which no test and no measurement backs.

## Measured result (T030, 2026-10-18)

The run used qwen2.5:3b through Ollama 0.31.1, with `OLLAMA_CONTEXT_LENGTH=32768`, on an Arc A370M
laptop GPU with partial offload. It covered 1,805 Claude Code transcripts and 64,510 tool results,
and counted with the Xenova/gpt-4o tokenizer. Each pair of figures below is with large file reads
left out, then with them included.

- **Gross saving:** 699,549 / 1,149,719 tokens avoided as new input, which is 2.14% / 3.52% of all
  tool-result tokens. Weighted by the bill, that is 0.35% / 0.48% of the sample's input bill.
- **Plain net: not a saving.** The worker read 1,154,393 / 1,955,779 tokens, about 1.7 tokens per
  token spared. This holds for any model, because the worker must read the whole result to
  condense it.
- **Bill-weighted net:** +0.29% / +0.37% of the bill. The main model re-reads the history from
  cache on every later turn, while the worker reads each result once.
- **Latency:** 0 of 215 worker calls finished inside the shipped `waitMs` of 15,000 ms (median
  47 s). At defaults on that laptop, the module forwards everything whole and saves nothing.
- **Facts kept (SC-002):** not shown. The labelled subset is 10 results (20 with file reads),
  against 50 required, and 0 fact lines appeared verbatim. The maintainer decided on 2026-10-18 to
  record SC-002 as unmet. Do not lower the criterion.
- **The ceiling:** about 0.5% of the bill with any model. The free upper bound measured before
  planning was 0.54%. For comparison, the truncator module cut the bill by 5.7% (see
  `.specify/projects/llm-fw/token-savings-findings.md`).

The maintainer chose to open the PR without merging it, knowing these figures.

## Depends on: GHSA-83jp-cppw-c3v6

Detection did not scan OpenAI Responses API tool output (`function_call_output` and siblings, as
sent by Codex CLI). This branch says so in `spec.md`, `data-model.md`, `tasks.md` and four test
files, and the module therefore forwards Codex tool output whole (#377).

- **The fix:** commit 6841cd4 on `fix/ghsa-83jp-responses-tool-output`, as PR #1 in the
  advisory's temporary private fork `PIsberg/llm-fw-ghsa-83jp-cppw-c3v6`. GitHub Actions does not
  run there.
- **Before the fix:** the new gateway e2e case forwarded an injection in `function_call_output`
  with 200. The fixed parser refuses it with 422.
- **Ruleset 2026.10.65:** 0 of 23,938 eval verdicts changed, and `fpr` is unchanged.
- **On real Codex traffic:** 31 of 1,382 tool outputs (2.2%) are now refused, all benign. The same
  stages refuse the same text from Claude Code.
- **Order:**
  1. The maintainer merges that PR and publishes the advisory.
  2. Upstream CI runs on `main` and goes green.
  3. Then this branch is rebased onto it (step 1 below).

## Remaining work, in order

1. **Rebase onto `main` after the fix merges.**
   - Only `CHANGELOG.md` and `src/detection/ruleset.ts` touch the same lines on both branches.
   - This branch re-pinned `RULESET_DIGEST` without a version cut, because `pipeline.ts` and
     `config.ts` changed but no verdict moved. After the rebase, run `npm run ruleset:digest` and
     re-pin. Then run `npm run verdicts:dump` on main and on the branch, and `npm run verdicts:diff`,
     to decide whether this branch needs its own cut.
2. **Flip every Responses statement.** Once the parser reads `*_call_output`, Responses tool output
   is scanned like any other, so the shunt condenses it. The places that say otherwise:
   - `spec.md`: FR-012, FR-016, FR-018, US1-5, US1-6, the Edge Cases and the H1 clarification.
   - `data-model.md` (the note that today every Responses `function_call_output` is unscanned)
     and the T017 wording in `tasks.md`. `plan.md` speaks of unscanned results in general, which
     stays true.
   - `test/modules/toolResultShunt.test.ts`: the describe block "an OpenAI Responses
     function_call_output, which the detection does not read".
   - `test/gateway/gateway-shunt.e2e.test.ts`: "forwards a large OpenAI Responses
     function_call_output whole".
   - `test/modules/screening.test.ts`: "flags an OpenAI Responses function_call_output the item
     loop never noted".
   - `test/detection/pipeline-item-flag.test.ts`: "is never called with an OpenAI Responses
     function_call_output".
   - The Tool result shunt section of `docs/guides/token-savings.md`. The gatekeeper found no
     Responses statement there yet; FR-018 required one, and step 3 adds it in its flipped form.

   Add Codex's `shell_command` to the default `tools`. The Codex replay shows it is the tool Codex
   uses most, and only `shell` and `exec_command` are listed. The spec edits void the spec-auditor's
   PASS, so re-audit before any test-writer or implementer runs. Write the flipped tests first and
   see them fail.
3. **Close the FR-018 doc gaps** the gatekeeper listed. The guide section, the CHANGELOG entry and
   `configuration.md` lack:
   - what is sent to the worker (only the result and fixed instructions, no credential);
   - that stored originals and outcome files rest on disk unencrypted and can hold secrets;
   - that SYSTEM can read the folder on Windows;
   - what the missing second detection pass leaves uncaught (a worker repeating or obeying an
     injection the scan missed);
   - a thread continuation whose stored original has expired;
   - an agent in a sandbox, a container or another account, which cannot read the stored original;
   - the Responses statement, written after step 2 as "condensed like the others".
4. **Record SC-002 as unmet** in the guide and the PR body: 10 labelled results, 0 fact lines
   verbatim, and the module is not recommended on this evidence. Open one issue for a larger
   labelled set and a worker prompt that copies failing lines verbatim.
5. **Re-run the spec-gatekeeper** (`Feature directory: specs/001-tool-result-shunt/`). It will still
   reject on SC-002. Put that to the maintainer as the decision already taken, not as a defect to
   route.
6. **Keep draft PR #392 green, and do not merge it.** After every push, arm
   `gh pr checks 392 --watch` in the same turn and fix red checks until every one is green. Update
   the PR body when a step above lands. Merging is the maintainer's call.
7. **Close issues as their work lands.** One issue per left-behind item was opened with the PR:
   - #375: FR-018 doc gaps.
   - #376: SC-002.
   - #377: Responses flip.
   - #378: remote worker.
   - #379: hosted worker.
   - #380: way back for remote agents.
   - #381: encryption.
   - #382: SC-007.
   - #383 to #390: the accepted findings below.
   - #391: tool-output false positives.

## Maintainer decisions already taken

Do not re-ask these. The plan's Open Decisions section holds the options.

- **D1 to D8:** the recommended options.
- **D9 C:** remembered outcomes are persisted beside stored originals, so a restart cannot change
  a condensed result's bytes. A preserved-thinking model answers 400 when an earlier prefix changes.
- **D10:** go.
- **D11:** FR-012 wins on a later flag.
- **D12:** forward whole if the worker's prompt tokens fall under 0.8 times the expected count.
- **D13:** `maxInputChars` stays 200,000.
- **D14:** the Xenova/gpt-4o tokenizer for T030.
- **FR-011:** the worker runs on the same machine only.
- **FR-012:** the original is scanned before condensing; flagged or unscanned results stay whole.
- **FR-013:** a disk copy that the agent reads by path.
- **SC-002:** recorded as unmet.
- **D7:** the billed comparison stage is not approved. It needs the maintainer's go-ahead.

## Accepted findings (MEDIUM and LOW, not fixed)

These are from the spec audits, the security reviews and the build rounds.

- Remote-client detection uses the socket peer, so a same-host reverse proxy or sidecar makes a
  remote agent look local (FR-011 enforces loopback, not "same machine"; an SSH forward passes).
- Worker output reaches the agent unscanned; the limits are a local worker, the citation check and
  the 50% cap. A possible follow-up is a heuristic-only re-check of the worker's facts.
- `Screening` receives text only, so a prompt whose text is exactly a tool output's text still
  counts that output as scanned. Closing it needs `onItemScanned` to carry the item's surface.
- The same text under two tool names shares one stored original, so flagging one deletes it for
  the other.
- In observe mode, a flag leaves the stored original and the outcome file until expiry.
- `citationsValid` treats a trailing `.` as part of a path, so "see src/a.ts." sends the result
  whole (safe, costs savings).
- The way back assumes the agent may read `<LLM_FW_DIR>/tool-results/`; `claude -p` without
  `--add-dir`, a sandbox or a container cannot (unverified for `claude -p`).
- The real module has no proxy e2e; the proxy cases use a probe module.
- `test/eval/shunt/compare.ts`: the billed child is limited to `Bash(awk:*)`, Read, Grep and Glob,
  but `awk system()` can still spawn processes, parent-directory settings are not checked, the
  child gets the full parent environment, and the `Bash(awk:*)` syntax is unverified without a
  paid run.
- Audit 6 LOWs L1 to L13 (in the audit report): stale decision quotes, FR-008 overrun by store
  writes and `icacls`, no `--max-input-chars` on the replay, "off does not delete at once"
  untested, FR-004 without a runtime check, and the outcome replay going from observe to enforce.

## Found on the way, outside this feature

- **#374:** DLP redaction can leave a request body that is not valid JSON. The module fails open
  on such a body (`parsePayload` returns null), and the replay counts it as flagged (7ec55c0).
- **Tool-output false positives:** with the Codex fix, 31 of 1,382 real Codex tool outputs are
  refused, and each is refused by the same stage as an Anthropic `tool_result`. The text is build
  files, READMEs, source files, test logs and diffs. This is existing behaviour for Claude Code,
  worth its own detection issue once the advisory is public.

## How to work here (traps that cost time in this run)

- **Spec Kit:** `.specify/feature.json` is gitignored and points at this folder. Switching the main
  checkout to another branch breaks `/speckit-board` and the speckit-team hooks. Do side work in a
  separate worktree, with a junction to `node_modules` when the lockfile matches.
- **The lane check** (`speckit-team.mjs`) treats every path under `test/` as a test file, so only
  the test-writer can edit `test/eval/shunt/replay.ts` and `compare.ts`. Write the test, see it
  red, then make a separate implementation launch.
- **Test environment:** set `LLM_FW_MODEL_DIR=$HOME/.llm-fw/models` and a scratch `LLM_FW_DIR` for
  every test run. Never write to the real `~/.llm-fw`. Run the unit and e2e halves separately.
- **Gateway e2e tests** must post to `/testprovider/...`. A bare `/v1/messages` routes to the
  built-in Anthropic provider and leaves the machine. That happened once in this run: 9 requests,
  no key sent.
- **Ollama:** `ollama list` starts the desktop app. Start `ollama serve` yourself with
  `OLLAMA_CONTEXT_LENGTH=32768`, and stop every process you start. Do not pull a model without the
  maintainer's go-ahead.
- **Approvals:** do not call a paid API, spawn `claude -p`, or run `llm-fw setup` without the
  maintainer's go-ahead.
- **The lean-ctx shell** blocks `node -e`, so write a script file. Its foreground commands detach
  after about 110 s; run long jobs in the background.
- **A full replay** (`npm run eval:shunt:replay`) took about 2 hours of worker time per run on the
  laptop above.
- **The wait-limit test** in `toolResultShunt.test.ts` now takes about 3 s by design (7ec55c0).
