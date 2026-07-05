# PLAN — Improvements batch 2 (post intent-mention/two-tier)

Branch: `feat/improvements-batch2-2026-07`, stacked on
`feat/intent-mention-and-blending`. Tasks run **sequentially, one commit each**,
by separate agents. Every task ends with `npx tsc --noEmit`, `npx eslint .`,
its listed tests green, then a commit on THIS branch (no push).

Ground rules (every task):
- NEVER touch e5 embedding thresholds/anchors or batch embedding calls (q8
  calibration is locked; see embedding.ts comments).
- `npm run scorecard` must stay 100% TPR / 0% FPR before each commit that
  touches `src/detection/**` or `src/proxy/**`. Regression ⇒ STOP and report.
- stage3-judge.test.ts fails without live Ollama — pre-existing, exclude it
  from suite runs; never "fix" it.
- Defaults must be behavior-preserving unless the task says otherwise.
- State dir access ONLY via `getLlmFwDir()` (src/config/paths.ts).
- Network downloads (HF models): attempt once, degrade gracefully (feature
  stays disabled + console.warn), never hard-fail startup or tests without
  network. Mirror src/detection/classifier.ts lazy-load pattern.
- Commits: conventional message per task + trailers
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01GGV5S8GnGfQJMfBfSMiawr`

## Task B1 — Re-measure the accuracy frontier post C+B
No src changes. Run the test/eval runner (see run-benchmark.ts): heldout +
safeguard + injecagent splits, cheap preset AND classifier preset (classifier
preset downloads DeBERTa — attempt, skip gracefully offline; judge-dependent
paths: skip if Ollama unreachable, note it). Compare against the baselines in
future_improvements_plan.md (heldout classifier 77.4%/23.8%). Write results
into docs/BENCHMARK-IMPROVEMENTS.md ("After intent-mention + two-tier" section)
and refresh the table in future_improvements_plan.md.
Commit: `docs(benchmark): re-measure heldout/safeguard after intent-mention + two-tier`

## Task B2 — Dashboard false-positive feedback loop (suppression list)
Files: src/dashboard/server.ts (+ static UI), new src/detection/suppressions.ts,
pipeline.ts, types.ts, config.ts, tests.
- New module: persisted suppression store at `<getLlmFwDir()>/suppressions.json`
  — entries `{ hash, preview, addedAt }` where hash = sha256 of the NORMALIZED
  prompt text (reuse the embedding LRU's normalization+hash helper if exported;
  else mirror it). Load at init, in-memory Set, atomic read-merge-write on add
  (follow the config.json read-merge-write pattern).
- Pipeline: immediately before any BLOCK on sources 'prompt'|'system' (all
  stages), if the candidate's normalized hash is suppressed → downgrade to warn
  (emitted line notes `[suppressed-fp]`). NOT applied to tool_result/document.
- Dashboard: events already render; add a "Mark false positive" button on block
  events → `POST /api/feedback { eventId }` → server resolves the event's
  prompt text → suppressions.add. Respect existing dashboard auth-token
  middleware. Also `GET /api/suppressions` + delete endpoint.
- Config: `detection.suppressions?: boolean` default true; env
  `LLM_FW_SUPPRESSIONS_ENABLED`.
- Tests: unit (store add/load/normalized-hash match), pipeline (suppressed
  prompt warns instead of blocks; tool_result ignores suppressions), dashboard
  endpoint test following existing server tests.
Commit: `feat(dashboard): operator false-positive feedback -> persisted suppression list`

## Task B3 — Per-source detection sensitivity
Files: types.ts, config.ts, pipeline.ts, tests.
- Config: `detection.surfaces?: { [S in 'tool_result'|'document']?: {
  heuristicBlockThreshold?: number; embeddingMarginThreshold?: number } }`.
  Defaults ABSENT ⇒ bit-identical behavior. Only these two knobs; embedding
  block/warn cosines stay global (calibration rule).
- Pipeline: resolve effective thresholds per candidate from its source before
  the Stage 1/2 comparisons.
- Env: LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD (parseInt, guarded) only — file
  config carries the rest.
- Tests: override lowers tool_result heuristic threshold ⇒ borderline
  tool_result blocks while same text on prompt surface passes; absent config ⇒
  existing pipeline tests untouched and green.
Commit: `feat(detection): per-surface sensitivity overrides (tool_result/document)`

## Task B4 — Cross-request crescendo tracking
Files: src/detection/crescendo.ts, pipeline.ts, types.ts, config.ts, tests.
- Today detectCrescendo analyzes intra-request history only. Add an in-memory
  per-session escalation memory: key = same session identity the DoS budget
  uses (find it in src/proxy/** — reuse, do not invent a new identity), value =
  ring buffer (last N=8) of per-request topic/escalation scores + timestamps,
  TTL 30 min, max 500 sessions (LRU evict).
- When a request's own history is short (< crescendo's min turns), merge the
  session buffer before scoring. Config: `crescendo.crossRequest?: boolean`
  default FALSE (opt-in — memory growth + shared-proxy multi-tenant risk);
  env LLM_FW_CRESCENDO_CROSS_REQUEST.
- Tests: same session, escalating single-turn requests across calls → warns/
  blocks per crescendo.mode at the configured threshold; different sessions
  don't cross-contaminate; TTL expiry; default-off leaves existing tests green.
Commit: `feat(detection): opt-in cross-request crescendo session memory`

## Task B5 — Option D: output-side moderation classifier
Files: new src/detection/outputClassifier.ts, src/proxy/upstream.ts (or the
runResponseHarmScan call site in proxy), types.ts, config.ts, tests.
- Mirror classifier.ts: lazy ONNX text-classification via
  @huggingface/transformers, opt-in `responseScan.classifier?: { enabled:
  boolean (default false); model?: string (default
  'protectai/distilroberta-base-rejection-v1' — verify it loads with
  transformers.js; if not, pick a small (<100MB) HF text-classification
  moderation model that does, and record the choice); blockThreshold?: number
  (default 0.9) }`. Env LLM_FW_RESPONSE_CLASSIFIER_ENABLED / _MODEL / _THRESHOLD.
- Wire beside detectHarmfulCompliance in the response-harm scan path (buffered
  JSON + flushed SSE text): classifier verdict ≥ threshold ⇒ respect
  responseScan.mode (audit→warn event kind 'response-harm', block→block).
- Tests: mocked classifier (vi.mock, as pipeline tests do) — audit warns,
  block blocks, disabled never loads; graceful degradation when model load
  throws. NO real download in tests.
Commit: `feat(response): opt-in trained output-side moderation classifier (Option D)`

## Task B6 — Option A: competitor benchmark adapters
Files: new test/eval/competitors/ (adapter interface + runners), docs.
- Adapter interface: `{ name, available(): Promise<boolean>, classify(text):
  Promise<{ injection: boolean; score?: number }> }`. Adapters:
  (a) protectai DeBERTa standalone (reuse our classifier loader, thresholds
  0.5 default — this doubles as ablation baseline); (b) Meta Prompt Guard 86M
  via transformers.js; (c) Llama Guard 3 via local Ollama if the model is
  pulled; (d) Lakera Guard API iff LAKERA_API_KEY env set. Each SKIPS cleanly
  when unavailable and the report marks it "not run".
- Runner: `npm run bench:competitors -- --only=<split>` reusing test/eval/data
  loaders; outputs per-adapter recall/FPR on heldout + safeguard + injecagent
  into docs/BENCHMARK-COMPETITORS.md, plus a recall-vs-FPR SVG scatter
  (generate with a small script, no new deps) embedded in the doc, llm-fw's
  cheap + classifier presets plotted as reference points.
- Run what is runnable on this machine; record which adapters actually ran.
Commit: `feat(eval): competitor guardrail adapters + head-to-head report (Option A)`

## Task B7 — Multilingual indirect-injection embedding study (research, no wiring)
Files: new scripts/study-ml-indirect.ts + docs/ML-INDIRECT-STUDY.md. NO pipeline
changes — the e5 calibration rule forbids casually wiring a new embedding gate.
- Build a small probe set (reuse multilingual-indirect test fixtures + generate
  out-of-table cases: Zulu/Swahili-adjacent Bantu, 2-3 others) of indirect
  imperatives planted in tool_result JSON, plus benign tool payloads.
- Measure: current detector hit/miss per language; e5 cosine (query-prefixed)
  of the payload against the existing injection + benign anchors; report
  whether any margin threshold separates attacks from benign tool data at 0 FP.
- Deliverable: the doc with tables + a go/no-go recommendation for a
  tool_result-scoped embedding fallback. Honest negative result is acceptable.
Commit: `docs(research): multilingual indirect-injection embedding feasibility study`

## Task B8 — Release prep v0.2.0 (no publish)
- Update CHANGELOG.md (everything since v0.1.x: providers/Bedrock, OCR,
  multilingual 56-lang, trusted surfaces, contrastive margin, benchmark suite,
  bypass, intent-mention, two-tier, this batch), bump package.json to 0.2.0,
  refresh README feature list + scorecard/benchmark numbers (regen via
  `npm run scorecard -- --readme` if that flag exists per package.json).
- DO NOT `npm publish`, DO NOT tag — the operator releases manually.
Commit: `chore(release): prepare v0.2.0 changelog + version bump`
