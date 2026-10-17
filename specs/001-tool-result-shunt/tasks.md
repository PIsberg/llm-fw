---

description: "Task list for the Tool Result Shunt"
---

# Tasks: Tool Result Shunt

**Input**: `specs/001-tool-result-shunt/` (plan.md, spec.md, data-model.md, contracts/interfaces.md, quickstart.md)

**Tests**: required (constitution II). Each slice is its failing tests, then one implementation task.

**Organization**: phases are rounds of up to 4 slices with disjoint files; a slice builds and tests
without the slices after it. Setup and foundational tasks carry no story label.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: files disjoint from every other task in the same phase
- **[Story]**: the user story the slice delivers (US1 to US7)

---

## Phase 0: Is it worth building? (round 0: S0)

### S0. Savings ceiling

- [ ] T000 Measure the savings ceiling before any build work (plan D10). In a scratch directory outside the repo, write an uncommitted `.mts` script run with `node --import tsx/esm` (`node -e` is blocked) that streams every `~/.claude/projects/**/*.jsonl` modified in the last 30 days line by line, pairs each assistant `tool_use` {id, name, input} with the user `tool_result` {tool_use_id, content} answering it (as T021 pairs them), and applies steps 1 to 5 of data-model.md "Eligibility" with the defaults of data-model.md "Config" (`tools`, `minLines`, `minChars`, `maxInputChars`, names matched as `toolResultTruncate.skipTools`), once as configured and once with Claude Code `Read` added (file reads included, spec Assumptions). Count tokens with `AutoTokenizer.from_pretrained('Xenova/gpt-4o')` (`@huggingface/transformers`) on LF-normalised text. Report the date, sessions read, tokenizer and, for both runs: (a) eligible tool-result tokens as a share of all tool-result tokens; (b) the ceiling, the sum over eligible results of their tokens times the assistant entries after them in the same file, as a share of those files' prompt tokens (`message.usage` `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, each `message.id` counted once). (b) assumes every condensation is empty and detection flags nothing, so the real saving is lower. The script prints counts only, never tool output, and writes nothing under `~/.llm-fw`. Hand the figures to the owner, who decides whether Phase 1 starts. No test task: a measurement.

---

## Phase 1: Setup and foundations (round 1: S1 to S4)

### S1. Config and registration

- [ ] T001 [P] Write failing tests in test/modules/toolResultShunt.test.ts: `DEFAULT_CONFIG.modules.toolResultShunt` (src/config/config.ts) matches data-model.md "Config" (FR-001, FR-002, FR-003, FR-008, FR-024, FR-025); its `tools` shares no name with `DEFAULT_CONFIG.modules.toolResultTruncate.skipTools`; `new ModuleManager(config).getModule('tool-result-shunt')` (src/modules/registry.ts) exists and is disabled (US4-1). test/modules/builtins.test.ts already walks `BUILTINS` for the `LLM_FW_TOOL_RESULT_SHUNT_ENABLED` switch and warm options (US4-2, US4-5); leave it unchanged.
- [ ] T002 [P] Add the config and a stub module: `export interface ToolResultShuntConfig extends ModuleSwitchConfig { tools: string[]; minLines: number; minChars: number; maxInputChars: number; waitMs: number; workerUrl: string; workerModel: string; retentionHours: number; maxStoreMB: number }` and `ModulesConfig.toolResultShunt?: ToolResultShuntConfig` in src/types.ts (beside `LeanCtxConfig`); the default in `DEFAULT_CONFIG.modules` in src/config/config.ts; `LLM_FW_TOOL_RESULT_SHUNT_ENABLED` in `ENV_OVERRIDES` (same file, shape of `LLM_FW_LEAN_CTX_ENABLED`); one `['modules', 'toolResultShunt', <key>]` per key in `HOT_PATHS` (src/config/hotReload.ts); `export class ToolResultShuntModule extends SlotModule<ToolResultShuntConfig>` (src/modules/base.ts) in src/modules/builtin/toolResultShunt.ts with `id = 'tool-result-shunt'`, `name = 'Tool Result Shunt'`, a description, `kinds = new Set<SlotKind>(['tool_result'])` (`SlotKind`, src/modules/payload.ts), `constructor(config?: ToolResultShuntConfig)` defaulting like `LeanCtxModule`, and `rewrite` returning the text; its `BUILTINS` entry just before `responseCache` in src/modules/registry.ts. Re-pin `RULESET_DIGEST` in src/detection/ruleset.ts from `npm run ruleset:digest` (config.ts is hashed; no `RULESET_VERSION` cut) and regenerate the environment table in docs/guides/configuration.md with `npm run config:reference` (test/config/config-reference.test.ts).

### S2. Screening record

- [ ] T003 [P] Write failing tests in test/modules/screening.test.ts for `Screening` (src/modules/screening.ts) against data-model.md "Screening record" (FR-012, D1): each way a slot is flagged, each way `all` becomes true, `flagged` still holding the slots it can place while `all` is true (slot-count mismatch skips only the DLP rule), a flagged result beside an unflagged one (US6-3), a DLP match that appears only JSON-escaped (a PEM key spanning lines), and the unscanned rule: a slot no `noteItemScanned` text contains is in `flagged` while `all` is false and not on that account while `all` is true, an Anthropic array-content result noted as its parts joined by `\n` (`toolResultText`, src/detection/parsers.ts) counts as scanned, and an OpenAI Responses body (`input` items `function_call` and `function_call_output`) whose output was never noted has that slot in `flagged` (FR-012, US1-6). Bodies as Anthropic `tool_result`, OpenAI chat `role: 'tool'` and OpenAI Responses `function_call_output` payloads; slots from `collectTextSlots` (src/modules/payload.ts); findings as `DlpFinding` (src/types.ts) or from `DlpScanner.scan` (src/detection/dlp/scanner.ts).
- [ ] T004 [P] Implement src/modules/screening.ts: `export class Screening { noteItemScanned(text: string): void; noteItemFlag(text: string): void; noteDlp(preDlpBody: string, findings: readonly DlpFinding[]): void; noteMcpAudit(toolUseId: string): void; incomplete(): void; flaggedSlots(slots: readonly TextSlot[]): { flagged: ReadonlySet<number>; all: boolean } }` per data-model.md "Screening record", using `parsePayload` (src/modules/base.ts), `collectTextSlots` and `TextSlot` (src/modules/payload.ts), `DlpFinding` (src/types.ts). It logs nothing.

### S3. Worker client and condensed result

- [ ] T005 [P] Create test/modules/fixtures/fakeWorker.ts, `export async function startFakeWorker(reply?: (body: unknown) => { status?: number; json?: unknown; raw?: string; delayMs?: number; location?: string }): Promise<{ url: string; received: Array<{ headers: http.IncomingHttpHeaders; body: unknown }>; close(): Promise<void> }>`, a loopback `node:http` server for `POST /v1/chat/completions` whose default reply is one short fact list with `usage`. Write failing tests in test/modules/shuntWorker.test.ts for src/modules/shuntWorker.ts against contracts/interfaces.md sections 1 to 3: request body and headers (FR-010, US3-6); a non-loopback `workerUrl` never reaches `fetchImpl` (FR-011, US3-7); a 307 to a second fake worker is not followed; the deadline bounds the wait (US3-1); each citation rule and the FR-005 cap give `rejected`, empty or malformed answers give `worker-failed` (US3-2, US2-3); an accepted answer renders as section 1, naming only the stored file and no expiry (FR-004, FR-013, US2-2).
- [ ] T006 [P] Implement src/modules/shuntWorker.ts per contracts/interfaces.md sections 1 to 4: `export const WORKER_INSTRUCTIONS: string`; `export function isLocalWorkerUrl(url: string): boolean` (with `isLoopbackAddr`, src/auth.ts, after stripping IPv6 brackets); `export function numberLines(text: string): string`; `export function textSize(text: string): { lines: number; chars: number }` (data-model.md "Size"); `export function renderCondensed(original: string, facts: string, path: string): string`; `export function citationsValid(facts: string, original: string): boolean`; `export type CondenseOutcome = { text: string; tokensIn: number; tokensOut: number } | { reason: 'worker-failed' | 'rejected' }`; `export async function condense(original: string, path: string, worker: { url: string; model: string }, deadline: number, fetchImpl?: typeof fetch): Promise<CondenseOutcome>`. Tokens through `estimateTokens` (src/modules/tokens.ts); fetch as in `JudgeClient.classify` (src/detection/judge.ts) plus `redirect: 'error'`.

### S4. Stored originals

- [ ] T007 [P] Write failing tests in test/modules/shuntStore.test.ts for `StoredOriginals` (src/modules/shuntStore.ts) against data-model.md "Stored original", each with a scratch `LLM_FW_DIR` set and removed as in test/gateway/gateway-modules.e2e.test.ts `beforeAll`/`afterAll`: folder only under `getLlmFwDir()` (US7-1); path absolute, content-free, one file per content (FR-021, US2-6); bytes identical (US2-4); a failed write leaves no file or temp file (US2-5); access bits on POSIX (`it.runIf(process.platform !== 'win32')`) and an icacls listing with no group or Everyone entry on Windows (`it.runIf(process.platform === 'win32')`) (FR-023, US7-2, D5); `unrestricted` when the restriction cannot be confirmed (US7-3; on Windows, unset `USERNAME`); concurrent writes reserve against the cap and get `full` without deleting anything (US7-7, SC-011); `touch` false for a missing file; `sweep` by mtime with rebuilt totals (US7-4, US7-5); `purge` (US7-6); `startSweeping` sweeps at once and every `everyMs` under `vi.useFakeTimers`, reading the retention getter each time (FR-025).
- [ ] T008 [P] Implement src/modules/shuntStore.ts per data-model.md "Stored original": `export type StoreResult = 'stored' | 'full' | 'failed' | 'unrestricted'`; `export class StoredOriginals { constructor(maxBytes: () => number); dir(): string; pathFor(text: string): string; write(text: string): Promise<StoreResult>; touch(text: string): Promise<boolean>; sweep(retentionMs: number): Promise<number>; purge(): Promise<number>; stats(): { files: number; bytes: number }; startSweeping(retentionMs: () => number, everyMs?: number): () => void }`, with `getLlmFwDir` (src/config/paths.ts) per call, `restrictDirPermissions` (src/proxy/certs.ts) on Windows after checking `process.env.USERNAME` (it returns silently without one), an unref'd timer, and no content in any log.

---

## Phase 2: Foundational hooks (round 2: S5, S6)

### S5. Detection reports flagged items

- [ ] T009 [P] Write failing tests in test/detection/pipeline-item-flag.test.ts (setup as test/detection/pipeline.test.ts) for `meta.onItemScanned` and `meta.onItemFlag` on `Pipeline.run` (src/detection/pipeline.ts; FR-012, D1): `onItemScanned` called once with the text of every scan item, fresh and from the item cache, and never with an OpenAI Responses `function_call_output` output (the gap FR-012 covers); `onItemFlag` called with the text of every scan item whose own outcome is a warn, on a fresh scan and on a repeat served from the item cache, and of every item handed to the async judge (`judgeEnabled: true`, `judgeBlock: false`, `JudgeClient.classify` stubbed); not called for passing items; the `PipelineResult` and the emitted events are the same with and without the callback.
- [ ] T010 [P] In src/detection/pipeline.ts add `onItemFlag?: (text: string) => void` to the `meta` of `run` and `scan` and call it with the item text (`prompt` in the item loop) at the item-cache hit when `cached.warn` is set, just before `pendingWarn = firstWarn(warnBeforeItem, pendingWarn)` when the item's own `pendingWarn` is set, and beside `this.judge.classify(candidate.text).then(...)` in the async branch; and `onItemScanned?: (text: string) => void`, called with `prompt` first thing in each pass of the `for (const { text: prompt, source } of scanItems)` loop, before the item-cache lookup. Do not touch src/detection/parsers.ts. Re-pin `RULESET_DIGEST` in src/detection/ruleset.ts with `npm run ruleset:digest`; no `RULESET_VERSION` cut. Then prove the callback changes no verdict: `npm run verdicts:dump -- before.json` on main (a scratch worktree), `npm run verdicts:dump -- after.json` on the branch, `npm run verdicts:diff -- before.json after.json`, and record its "N of M eval verdicts changed" line (expected 0) for the PR body.

### S6. Post-screening module pass

- [ ] T011 [P] Write failing tests in test/modules/registry.test.ts (new `describe`, style of its fail-open cases): a module with `afterScreening: true` is skipped by `ModuleManager.transformRequest` and is the only kind `ModuleManager.transformScreened` runs (src/modules/registry.ts); `transformScreened` awaits `prepare`, passes `ctx.screening` and `ctx.remoteAddress` through, returns the rewritten body, and fails open when the module throws or rejects (FR-007); `ToolResultShuntModule` (src/modules/builtin/toolResultShunt.ts) has `afterScreening === true` and a `store` that is a `StoredOriginals` (src/modules/shuntStore.ts).
- [ ] T012 [P] In src/modules/types.ts add `afterScreening?: boolean` to `GatewayModule`, and `screening?: Screening` (src/modules/screening.ts) and `remoteAddress?: string` to `GatewayModuleContext`; in src/modules/registry.ts add `transformScreened(body: string, ctx: GatewayModuleContext): Promise<{ body: string; modified: boolean; events: ModuleEvent[] }>` sharing `transformRequest`'s loop, and make `transformRequest` skip `afterScreening` modules; in src/modules/builtin/toolResultShunt.ts add `readonly afterScreening = true` and `readonly store = new StoredOriginals(() => this.cfg.maxStoreMB * 1_048_576)`.

---

## Phase 3: Wiring and User Story 1, the MVP (round 3: S7, S8)

### S7. Wire the pass into proxy, gateway and start

- [ ] T013 [P] Write failing e2e cases. In test/proxy/proxy.e2e.test.ts pass a `ModuleManager` (src/modules/registry.ts) built from `testConfig` as `ProxyServer`'s fifth constructor argument in `beforeAll`, and register a probe module (`afterScreening: true`, enabled, records the body, `ctx.screening` and `ctx.remoteAddress` it gets, appends a marker to the body); add a case: the mock upstream receives the probe's body; events other than module events, and the traffic event's `requestBody`, equal those of the same request with the probe disabled (FR-012, D2); a DLP-redacted tool result is in `ctx.screening.flaggedSlots(...).flagged` and a clean one the scan reached is not (FR-012); `ctx.remoteAddress` is loopback; in observe mode the upstream receives the screened body (FR-015). Add the same probe case through `GatewayServer` to test/gateway/gateway-modules.e2e.test.ts.
- [ ] T014 [P] Wire the post-screening pass (plan Design 1, 2). src/proxy/proxy.ts `handleRequest`: `new Screening()` (src/modules/screening.ts) before DLP; `noteDlp(body, findings)` right after `this.dlp.scan(body)`, before any redaction; `onItemScanned: t => screening.noteItemScanned(t)` and `onItemFlag: t => screening.noteItemFlag(t)` in the `this.pipeline.run` meta; `incomplete()` in the fail-open branch and when `result.enforced === false`; `noteMcpAudit(tr.toolUseId)` on a tool-result `resResult.audit`; just before `this.modules.respond`, `this.modules.transformScreened(body, { ...moduleCtx, screening, remoteAddress: innerReq.socket.remoteAddress })`, its body (unless `moduleCtx.dryRun`) going to `respond`, `bodyBuf`/`forwardRequest`, `observeResponse` and the quota while `emitTraffic` and the loop tracker keep `body`; rewrite the comment above `moduleCtx` that says modules run before DLP and detection. src/gateway/gateway.ts: `screen` fills the same record (DLP on `text` before `redact`, pipeline meta, fail-open, `enforced === false`) and returns `{ blocked: false, body, screening }`; `handle` calls `transformScreened` after `screen` with `remoteAddress: req.socket.remoteAddress` and uses its body for `respond`, `forward` and `observeResponse` unless observing. src/cli/start.ts: after `new ModuleManager(config)`, if `modules.getModule('tool-result-shunt')` is a `ToolResultShuntModule`, start `store.startSweeping(() => (config.modules?.toolResultShunt?.retentionHours ?? 24) * 3_600_000)` and call its stop in `shutdown` (FR-025, US7-5).

### S8. US1: condense eligible results and replay them

- [ ] T015 [P] [US1] Write failing tests in test/modules/toolResultShunt.test.ts driving `new ModuleManager(config).transformScreened(body, ctx)` (src/modules/registry.ts) with the module enabled, `ctx.screening` from a local helper `scannedScreening(body: string): Screening` that notes every `collectTextSlots` (src/modules/payload.ts) text through `noteItemScanned` (src/modules/screening.ts; a bare `new Screening()` flags every result, FR-012), `ctx.remoteAddress = '127.0.0.1'`, `startFakeWorker` (test/modules/fixtures/fakeWorker.ts) and a scratch `LLM_FW_DIR`: eligibility order and reasons of data-model.md "Eligibility" with the boundary at exactly `minLines`/`minChars` (spec Edge Cases), file-reading tools excluded by default and condensed once included unless ranged (US1-7), a read naming a stored original never condensed; the condensed result of contracts section 1 at most 50% of the original's tokens with its file present and identical, and the file's cited line range holding the original's exact lines (US1-1, US1-3, US2-1, US2-4); tool names learned through `observeResponse` for a thread continuation (US1-5; `RememberedCalls`, src/modules/toolCalls.ts); the Anthropic and OpenAI chat tool-result formats (US1-6, FR-016; the Responses format is T017's); a 10-turn history resend byte-identical with one worker call and one file per distinct result (US1-4, SC-004); two requests carrying the same new result sent at once (fake worker `delayMs`) make one worker call and forward byte-identical bodies, as does a third sent later (FR-006); more than 4,096 distinct eligible results (`minLines` lowered) keep their first outcome with no second worker call while carried, and under `vi.useFakeTimers({ toFake: ['Date'] })` a result carried at least once per `retentionHours` keeps its outcome over three retention periods while one not carried for longer is decided again (D9, data-model.md "Remembered outcome"); five eligible results add at most one `waitMs` (US3-4); worker absent, erroring or slow gives whole, and whole again on later requests (US3-1, US3-3); a non-loopback `workerUrl` warns once over many requests (US3-7); no worker call and under 5 ms median added for a request with no eligible result (US3-5, SC-005); a changed `minLines` applies to the next request (US4-5); `enabled: false` leaves the body identical with no worker call and no folder (US4-1, SC-008); a non-loopback `remoteAddress` gives whole with no worker call and no file (US2-7); store `failed`, `unrestricted` or `full` gives whole (US2-5, US7-3, US7-7); `ctx.dryRun` asks the worker but writes nothing (FR-015, US4-3). US1-2 is the worker's quality, measured in T030 (SC-002); flags are T017's.
- [ ] T016 [P] [US1] Implement condensing in src/modules/builtin/toolResultShunt.ts: `export type WholeReason = 'below-threshold' | 'excluded-tool' | 'tool-unknown' | 'too-large' | 'remote-client' | 'flagged' | 'worker-failed' | 'rejected' | 'store-failed' | 'store-full'`; `export function eligibility(name: string | undefined, input: unknown, text: string, cfg: ToolResultShuntConfig, remoteAddress: string | undefined): WholeReason | null` (steps 1 to 6 of data-model.md "Eligibility", `textSize` from src/modules/shuntWorker.ts, `toolArgs` from src/modules/toolCalls.ts, `isLoopbackAddr` from src/auth.ts; null when eligible); `observeResponse` feeding `RememberedCalls.learn`; `prepare(payload, ctx)` shaped like `LeanCtxModule.prepare` (src/modules/builtin/leanCtx.ts): collect new eligible results, run `condense` (src/modules/shuntWorker.ts) on all of them under one deadline `Date.now() + cfg.waitMs`, then `this.store.write` unless `ctx.dryRun`, and remember each outcome per data-model.md "Remembered outcome": a `Map` with no entry cap whose `carriedAt` every carry sets, the hourly prune of outcomes uncarried for `retentionHours` (D9; T018 exempts `flagged`), and a private `inflight: Map<string, Promise<...>>` a request joins when its key is already being decided; `rewrite` returns the remembered condensed text; one `log.warn` per distinct problem through `createLogger('tool-result-shunt')` (src/logger.ts), never with text (plan Design 7).

---

## Phase 4: US6, US7, US5 (round 4: S9, S10, S11)

### S9. US6: flagged results stay whole

- [ ] T017 [P] [US6] Write failing tests for FR-012. In test/modules/toolResultShunt.test.ts: a result flagged through `ctx.screening` (`noteItemFlag`, `noteDlp`, `noteMcpAudit`, `incomplete`, and a context without `screening`) is forwarded whole, never reaches the fake worker, is not stored, and stays whole on later requests even when no longer flagged; its unflagged sibling is condensed (US6-2, US6-3); a result condensed on an earlier request stays condensed, byte-identical, on a later request where `all` is true (an `incomplete()` scan, a DLP match only in a `tool_use` input) or `screening` is absent while a new result there goes whole (FR-006), and goes whole only once its own slot is in `flagged`, `all` true or not (plan Design 8); an OpenAI Responses `function_call_output` result never noted through `noteItemScanned` is forwarded whole, never reaches the fake worker, is not stored, and stays whole on later requests, thread continuation included (FR-012, FR-016, US1-6); a result flagged on one of two concurrent requests while the other's worker call is under way ends remembered `flagged` whichever settles last; a `flagged` outcome is still whole after more than `retentionHours` uncarried (D9, Date faked as in T015). Create test/gateway/gateway-shunt.e2e.test.ts (fixed port 18231; setup as test/gateway/gateway-modules.e2e.test.ts with DLP on, the real module, `startFakeWorker`, `LLM_FW_MODEL_DIR` from the environment): one request end to end (US1-1); one `POST /v1/responses` request with `input` items `function_call` and `function_call_output` whose large output reaches neither the worker nor `<LLM_FW_DIR>/tool-results` (US1-6); then at least 50 requests whose large tool results detection flags (DLP secrets, injections from test/detection/fixtures/corpus.json) and at least 50 it does not, each sent with the module off and on: same status, same events other than module events, 0 flagged results at the worker or in `<LLM_FW_DIR>/tool-results`, one `Pipeline.run` (src/detection/pipeline.ts) per request (US6-1, US6-4, SC-009).
- [ ] T018 [P] [US6] In `ToolResultShuntModule.prepare` (src/modules/builtin/toolResultShunt.ts) call `ctx.screening.flaggedSlots(slots)` (src/modules/screening.ts) once per request over `collectTextSlots(payload)`; an eligible result not yet decided whose index is in `flagged`, or every such result when `all` is true or `ctx.screening` is absent, is remembered whole as `flagged` before any worker call or store write; a remembered condensed result becomes `flagged` only when its own index is in `flagged`, and `all` or a missing record leaves it condensed (step 7 of data-model.md "Eligibility", plan Design 8); a settling in-flight decision never replaces a `flagged` outcome, and the D9 prune skips `flagged` outcomes (data-model.md "Remembered outcome").

### S10. US7: delete all stored originals from the dashboard

- [ ] T019 [P] [US7] Write failing tests in test/dashboard/modules.test.ts (new `describe`, server set up as in its `/api/modules` describe, scratch `LLM_FW_DIR`): `POST /api/modules/tool-result-shunt/purge` per contracts/interfaces.md section 5 empties `<LLM_FW_DIR>/tool-results` and answers the count (US7-6, FR-025, SC-011); refuses non-JSON and cross-origin requests like `POST /api/modules`; leaves the module's `enabled` unchanged; `DASHBOARD_HTML` (src/dashboard/server.ts) carries the card's delete button.
- [ ] T020 [P] [US7] In src/dashboard/server.ts add the route per contracts/interfaces.md section 5 (guard `checkSameOrigin`; `modManager.getModule('tool-result-shunt')` checked with `instanceof ToolResultShuntModule` from src/modules/builtin/toolResultShunt.ts; `store.purge()`), and in `renderModuleCards` a "Delete stored originals" button on the card whose `m.id === 'tool-result-shunt'`, posting with `Content-Type: application/json` and then calling `loadModuleStats()`.

### S11. US5: replay stage

- [ ] T021 [P] [US5] Write failing tests in test/eval/shuntReplay.test.ts for test/eval/shunt/replay.ts, with a synthetic Claude Code transcript test/eval/shunt/fixtures/session.jsonl (assistant `tool_use` {id, name, input} lines, later user `tool_result` {tool_use_id, content} lines), an injected `countTokens` and `startFakeWorker` (test/modules/fixtures/fakeWorker.ts): pairing by id; every US5-1 figure with file reads excluded and included (spec Assumptions); CRLF counted as LF (FR-019); two runs agree on results seen, results eligible and original tokens (US5-2); stored files under a scratch `LLM_FW_DIR`, never under `join(homedir(), '.llm-fw')` (FR-020, US5-5); each condensed result's file identical to its original (SC-010); `extractKeyFacts` and retention per D6 (SC-002).
- [ ] T022 [P] [US5] Implement test/eval/shunt/replay.ts: `export interface ReplayItem { name: string; input: unknown; text: string }`; `export function pairToolResults(jsonl: string): ReplayItem[]`; `export function extractKeyFacts(original: string): string[]` (D6); `export interface ReplayReport` with the US5-1 figures plus `tokenizer`, `workerModel`, `sampleSessions`, `date`, `labelledSubset`, `fileReadsIncluded`; `export async function replay(items: ReplayItem[], opts: { worker: { url: string; model: string }; countTokens: (text: string) => number; includeFileReads: boolean; waitMs?: number }): Promise<ReplayReport>` using `eligibility` (src/modules/builtin/toolResultShunt.ts) with remote address `127.0.0.1`, `condense` (src/modules/shuntWorker.ts) and `StoredOriginals` (src/modules/shuntStore.ts); a `main()` (`--sessions`, `--max-sessions`, `--worker-url`, `--worker-model`, `--out`; entry pattern of test/eval/competitors/run.ts) that first sets `LLM_FW_DIR` to a new `mkdtemp` directory, takes sessions in sorted path order, counts with `AutoTokenizer.from_pretrained('Xenova/gpt-4o')` (`@huggingface/transformers`) on LF-normalised text, and writes both reports. Add `"eval:shunt:replay": "node --import tsx/esm test/eval/shunt/replay.ts"` to package.json.

---

## Phase 5: US4, US5 (round 5: S12, S13)

### S12. US4: the module's card

- [ ] T023 [P] [US4] Write failing tests in test/modules/toolResultShunt.test.ts (screening from T015's `scannedScreening`): `getStats().kpis` keys, labels and units per data-model.md "Counters" after a mix of condensed, whole-for-several-reasons and dry-run requests (FR-017, US4-4); `resetStats()` clears them; a marker inside a condensed result's original appears in no `getStats()` output, no event `transformScreened` returns, and no console line captured as in test/logger.test.ts (FR-014, US4-6 as D2 decides).
- [ ] T024 [P] [US4] In src/modules/builtin/toolResultShunt.ts count per data-model.md "Counters" and override `getStats(): ModuleStats` to return `{ ...super.getStats(), kpis }` (`ModuleStats.kpis`, src/modules/types.ts), with `storedFiles`/`storedBytes` from `this.store.stats()`; extend `resetStats()`; `missing` stays 0 until T028.

### S13. US5: comparison stage

- [ ] T025 [P] [US5] Write failing tests in test/eval/shuntCompare.test.ts for test/eval/shunt/compare.ts with an injected runner and stream-json fixtures in test/eval/shunt/fixtures/: without approval the report says the stage was not run and the runner is never called (US5-4, FR-020); per-arm prompt tokens, cache writes, cache reads, turns, correct answers and stored-original reads over tasks completed in both arms only (US5-3); stored-original reads counted from `tool_use` inputs matching `/[0-9a-f]{64}\.txt/`; the net stated when it is a loss; SC-007's not-recommended line when the module-on arm answers fewer correctly.
- [ ] T026 [P] [US5] Implement test/eval/shunt/compare.ts: `export interface CompareTask { id: string; prompt: string; expect: string }`; `export interface ArmRun { taskId: string; completed: boolean; correct: boolean; promptTokens: number; cacheWrites: number; cacheReads: number; turns: number; storedReads: number }`; `export function parseRun(streamJson: string, task: CompareTask): ArmRun`; `export interface CompareReport`; `export function summarise(off: ArmRun[], on: ArmRun[]): CompareReport`; `export async function compare(opts: { approved: boolean; tasks: CompareTask[]; run: (task: CompareTask, arm: 'off' | 'on') => Promise<string> }): Promise<CompareReport>`; a `main()` (`--approve-spend`, `--repo`, `--tasks`, `--worker-url`, `--worker-model`, `--out`) that only when approved starts a `ProxyServer` (src/proxy/proxy.ts) on spare ports with a scratch `LLM_FW_DIR` and its CA from `new CertFactory().ensureCA()` (src/proxy/certs.ts), enforce mode, the module off or on per arm, and spawns `claude -p --output-format stream-json --verbose --setting-sources project --strict-mcp-config` asynchronously in `--repo` with `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` set only for the child (method: .specify/projects/llm-fw/token-savings-findings.md, "Billed A/B"). Write test/eval/shunt/compare-tasks.json with at least 4 tasks (SC-007) whose commands print at least 350 lines, each with an `expect` regex. Add `"eval:shunt:compare": "node --import tsx/esm test/eval/shunt/compare.ts"` to package.json.

---

## Phase 6: US7, US4 (round 6: S14, S15)

### S14. US7: write missing stored originals back

- [ ] T027 [P] [US7] Write failing tests in test/modules/toolResultShunt.test.ts for FR-024 (screening from T015's `scannedScreening`): carrying a remembered condensed result again sets its file's mtime to now (US7-4); after `store.purge()` or a hand deletion the file is back at the same path, identical, before `transformScreened` returns, with the condensed text unchanged (US7-6, US7-8); when the write-back fails (store `full`, or the folder unwritable) the remembered condensed text is still forwarded, one warning is logged however many requests follow, and the `missing` KPI counts each (US7-9); in dry run nothing is touched or written.
- [ ] T028 [P] [US7] In `ToolResultShuntModule.prepare` (src/modules/builtin/toolResultShunt.ts), for each remembered condensed result in the request, one settled by a joined in-flight decision included, when not `ctx.dryRun`: `this.store.touch(text)`; when false, `this.store.write(text)`; when that is not `'stored'`, keep the remembered text, warn once, increment `missing`; all inside the request's deadline (FR-008).

### S15. US4: documentation

- [ ] T029 [P] [US4] Document the module (FR-018; constitution V, VI): a "### Tool result shunt" section in docs/guides/token-savings.md beside "### lean-ctx shell output compressor" covering every FR-018 item except the measured results (T030), as the Decisions were answered, including the shape change on a mid-conversation setting change, after a restart and after a retention period in which no request carried the result (D9); amend that guide's "It runs before DLP and detection" guarantee for this module; prose for `modules.toolResultShunt` in docs/guides/configuration.md next to `modules.leanCtx`, outside the generated table; an `## [Unreleased]` entry in CHANGELOG.md. Then `npm run docs:links`. No test task: documentation, checked by hand (quickstart.md section 3, US4-7).

---

## Phase 7: US5 measurement (round 7: S16)

### S16. US5: measured results

- [ ] T030 [US5] Run the replay stage per quickstart.md section 1 and add the measured results to the "Tool result shunt" section of docs/guides/token-savings.md (FR-018, SC-001, SC-002, SC-003, SC-006, SC-010): date, sample size, worker model, tokenizer, each US5-1 figure with file reads excluded and included, labelled-subset retention, and the net, saying so when it is not a saving; state that the comparison stage was not run unless D7 approved it. If no local worker can run, report the task as not run and write no estimate. No test task: a measurement.

---

## Dependencies & Execution Order

| Phase | Slices | Needs |
| --- | --- | --- |
| 0 | S0 | nothing |
| 1 | S1, S2, S3, S4 | the owner's go-ahead on T000's figures |
| 2 | S5, S6 | S1 (both: digest, stub); S2, S4 (S6) |
| 3 | S7, S8 | S5, S6 (S7); S3, S4, S6 (S8) |
| 4 | S9, S10, S11 | S7, S8 (S9); S6 (S10); S3, S4, S8 (S11) |
| 5 | S12, S13 | S8 (S12); S7, S8 (S13) |
| 6 | S14, S15 | S12 (S14); S9 (S15) |
| 7 | S16 | S11, S15 |

Within a slice: the test task first, seen failing, then the implementation. Within a phase the
slices touch disjoint files.

### Story coverage

| Story | Delivered by |
| --- | --- |
| US1 | T015, T016 (with T005, T006, T007, T008 underneath) |
| US2 | T005 to T008, T015, T016 |
| US3 | T005, T006, T015, T016 |
| US4 | T001, T002, T023, T024, T029 |
| US5 | T021, T022, T025, T026, T030 |
| US6 | T003, T004, T009, T010, T013, T014, T017, T018 |
| US7 | T007, T008, T014, T019, T020, T027, T028 |

## Parallel Example: Phase 1

Stubs from T002, T004, T006, T008 together; then T001, T003, T005, T007 written and seen failing
together; then the four implementations together.

## Implementation Strategy

- **Gate**: T000 first. If its ceiling is too small to pay for the build, the owner stops there and
  nothing else is built.
- **MVP**: Phases 1 to 3 give User Story 1 end to end in unit tests, but condense results detection
  flagged or did not scan until S9 lands. Nothing ships before Phase 4: US6 is a P1 safety property.
- **Incremental**: Phase 4 adds US6, the dashboard delete and the replay harness; Phases 5 and 6 the
  card, the comparison harness, write-back and the guide; Phase 7 the measured numbers.
