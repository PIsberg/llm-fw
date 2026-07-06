# PLAN — Improvements batch 3 (robustness, outbound guarding, ops, distribution)

Branch: `feat/improvements-batch3-2026-07`, stacked on
`feat/improvements-batch2-2026-07`. Tasks run **sequentially, one commit each**,
by separate agents. Every task ends with `npx tsc --noEmit`, `npx eslint .`,
its listed tests green, then a commit on THIS branch (no push).

Ground rules — IDENTICAL to PLAN-improvements-batch2.md ("Ground rules"
section applies verbatim: e5 calibration locked, scorecard 100/0 gate before
any src/detection|src/proxy commit, stage3-judge excluded, behavior-preserving
defaults, getLlmFwDir() only, graceful degradation on downloads, same commit
trailers).

Order: C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 → C9 (security first, then ops,
distribution, CI).

## Task C1 — Outbound tool_use argument scanning (exfil guard)
Files: src/proxy/** (response scan path — find runResponseHarmScan call site),
new src/detection/toolUseScan.ts, types.ts, config.ts, tests.
- Parse model-emitted tool calls from BUFFERED JSON responses and FLUSHED SSE
  streams for the formats the parsers already understand (Anthropic tool_use
  blocks; OpenAI tool_calls/function_call; Gemini functionCall) — extraction
  helpers live beside the existing response-harm plumbing.
- Over the serialized arguments run: (a) existing DLP pattern engine (reuse
  src/dlp/** — do not duplicate patterns), (b) existing UrlClassifier on any
  URL found in args (blocklist/DGA/entropy verdicts as it already produces).
- Config: `responseScan.toolUse?: { enabled: boolean (default true); mode:
  'audit'|'block' (default 'audit') }`; env LLM_FW_TOOLUSE_SCAN_ENABLED /
  _MODE. Event kind 'tool-use-exfil'.
- Block mode semantics: buffered → 403-style block body like other response
  blocks; SSE → follow whatever the existing response-harm block does (match
  it, do not invent new stream-abort machinery).
- Tests: unit on extraction per provider format; integration — DLP hit in
  args audits/blocks per mode; benign tool_use passes; URL-classifier hit on
  DGA domain in fetch args flags; SSE path covered with the existing SSE test
  fixtures pattern.
Commit: `feat(response): scan model tool-call arguments for DLP/URL exfiltration`

## Task C2 — Parser fuzz/property tests + explicit failMode
Files: new test/fuzz/parsers.fuzz.test.ts, src/proxy/** (pipeline error
boundary), types.ts, config.ts, docs.
- Add `fast-check` as devDependency.
- Property tests: every payload parser (Anthropic/OpenAI/Cohere/Gemini/Bedrock
  extractPrompts/extractSystem/extractConversation) and normalize()/
  normalizeSemantic()/decoder chain must NEVER throw on arbitrary JSON values /
  arbitrary unicode strings (fc.jsonValue, fc.fullUnicodeString, mutated real
  fixtures); decoders idempotent where documented. Fix any crashes found
  (defensive guards in the parser, not try/catch-swallow in the fuzz test).
- Find the proxy's current behavior when Pipeline.run() THROWS mid-request;
  make it explicit: `detection.failMode: 'open'|'closed'` — default must match
  today's observed behavior (verify first, document in the code comment which
  it was). 'open' forwards + emits an 'error' audit event; 'closed' blocks with
  the standard block response. Env LLM_FW_FAIL_MODE. Unit test both modes by
  injecting a throwing stage.
- README: short "Failure semantics" subsection.
Commit: `feat(proxy): explicit detection failMode + parser fuzz hardening`

## Task C3 — Inference isolation via worker_threads (opt-in)
Files: new src/detection/inferenceWorker.ts (+ worker entry), embedding.ts /
classifier.ts call sites, types.ts, config.ts, tests.
- Opt-in `detection.workerInference?: boolean` default FALSE (env
  LLM_FW_WORKER_INFERENCE). When on: embedding + classifier forward passes run
  in a single persistent worker thread (one worker, message-passing queue,
  lazy spawn on first use, terminate on shutdown hook). When off: bit-identical
  current in-process path.
- CRITICAL: results must be numerically IDENTICAL (same model, same single-text
  calls — the q8 calibration rule). No batching inside the worker.
- Crash policy: worker death ⇒ log, respawn once, if it dies again fall back
  to in-process and warn. Never drop a request (pending promises reject into
  the C2 failMode path).
- Tests: flag off ⇒ existing tests untouched; flag on ⇒ pipeline block/pass
  results identical on a fixture set (skip-if-no-model like other embedding
  tests); worker-crash respawn test with a mock worker.
Commit: `feat(detection): opt-in worker-thread inference isolation`

## Task C4 — Prometheus /metrics endpoint
Files: src/dashboard/server.ts, new src/dashboard/metrics.ts, tests.
- Hand-rolled text exposition (no new runtime dep): counters
  `llmfw_requests_total{surface}`, `llmfw_blocks_total{stage}`,
  `llmfw_warns_total{stage}`, `llmfw_events_total{kind}`; histograms
  `llmfw_scan_duration_ms` (buckets 5,10,25,50,100,250,500,1000,2500) overall
  and per stage if the pipeline already tracks per-stage timing (do not add
  invasive timing if absent — overall only); gauges for model-loaded states.
  Increment from the same hook where dashboard events are emitted + a scan
  timing callback.
- `GET /metrics` behind the existing dashboard auth middleware; config
  `dashboard.metrics?: boolean` default true; env LLM_FW_METRICS_ENABLED.
- Tests: scrape endpoint after simulated events, assert exposition format +
  counter values; auth enforced.
Commit: `feat(dashboard): prometheus /metrics endpoint`

## Task C5 — Config hot-reload
Files: src/config/config.ts (+ watcher module), proxy/dashboard wiring, tests.
- fs.watch on `<getLlmFwDir()>/config.json` (debounced 500ms, survives
  file-replace atomically-written saves). On change: re-run load+merge+env; DIFF
  against active config; apply ONLY hot-safe keys (detection.* toggles &
  thresholds, dlp/dos/rag/mcp/nonText/manyShot/crescendo/indirectInstruction/
  harmfulRequest/responseScan toggles+modes, suppressions). Cold keys (proxy
  ports/mode/bind, dashboard port/bind, targets/interceptDomains, TLS anything)
  ⇒ log "restart required: <keys>".
- Config object identity: pipeline holds a reference — mutate the live config
  object's hot keys in place (verify the pipeline reads config at scan time,
  not captured constants; where captured (e.g. thresholds read into locals per
  run() call is fine), confirm per-request reads).
- `config.hotReload?: boolean` default true; env LLM_FW_HOT_RELOAD.
- Tests: temp LLM_FW_DIR, write config, boot minimal pipeline harness, rewrite
  file with changed heuristicBlockThreshold ⇒ next scan uses it; cold-key
  change logs restart-required and does not apply.
Commit: `feat(config): hot-reload of detection settings`

## Task C6 — Documented programmatic API + middleware
Files: src/index.ts (public exports), new src/api.ts, README, new
examples/middleware-express.md (doc, not shipped code), tests.
- Public typed surface: `createFirewall(config?: DeepPartial<Config>) →
  { scan(input: { text?: string; body?: string; path?: string; surface?:
  ScanSource }): Promise<ScanVerdict>; close(): Promise<void> }` wrapping
  Pipeline init/run — ScanVerdict = { action: 'pass'|'warn'|'block', stage,
  score, similarity, events }. No proxy/TLS/dashboard startup.
- Ensure package.json `exports` exposes it cleanly (respect existing bundling;
  do not restructure the build).
- README section "Use as a library" with a 15-line example + note that the
  proxy remains the zero-integration path.
- Tests: createFirewall scans a known attack → block; benign → pass; close()
  releases (no open handles — vitest hangs are the regression signal).
Commit: `feat(api): documented programmatic scan API`

## Task C7 — Service packaging (auto-start)
Files: new src/cli/service.ts (subcommands install-service/uninstall-service),
templates, README.
- Windows: generate + register a Task Scheduler ONLOGON task via `schtasks`
  (no new deps) running `llm-fw start` with the user's saved config; macOS:
  write ~/Library/LaunchAgents/dev.llmfw.plist + `launchctl load`; Linux:
  user systemd unit to ~/.config/systemd/user/. Uninstall reverses each.
  Refuse politely with guidance when lacking rights.
- IMPORTANT: registration commands must be executed only on explicit user
  invocation of the subcommand — tests MOCK child_process/fs and assert the
  generated commands/units; CI never actually registers anything.
Commit: `feat(cli): install-service auto-start packaging (win/mac/linux)`

## Task C8 — Nightly benchmark trend CI
Files: .github/workflows/ (new nightly.yml), scripts/bench-trend.ts, docs.
- Nightly workflow (schedule + workflow_dispatch): checkout, npm ci, run the
  eval runner on heldout+safeguard+injecagent cheap preset (no Ollama in CI,
  no classifier download unless cached — cheap preset only), append
  `{ dateFromCI, commit, split, recall, fpr }` rows to
  docs/load-results/bench-trend.jsonl, fail the job if recall drops > 3pts or
  FPR rises > 1pt vs the last 7-run median (bench-trend.ts computes), commit
  the jsonl back on a bot branch/PR (use GITHUB_TOKEN, follow the repo's
  existing workflow conventions — read the current CI yml first).
- Tests: unit-test bench-trend.ts threshold logic with synthetic history.
Commit: `ci: nightly benchmark trend tracking with drift gate`

## Task C9 — Mutation testing on detection modules
Files: stryker.config.json, package.json (devDeps @stryker-mutator/core +
vitest runner, script `npm run mutation`), docs/TESTING.md section.
- Scope mutate to src/detection/{heuristic,normalize,intentMention,
  indirectInstruction,harmfulRequest,manyShot,crescendo}.ts (the regex-boundary
  modules); test runner = vitest with test/detection only, stage3-judge +
  model-download tests excluded. NOT wired into PR CI (too slow) — manual
  script + (optional) weekly workflow reusing C8 conventions.
- Run it once; record the baseline mutation score in docs/TESTING.md and list
  the top 5 surviving-mutant clusters as candidate test gaps (fixing them is
  OUT of scope for this task — record only).
Commit: `test: mutation testing harness + baseline for detection modules`
