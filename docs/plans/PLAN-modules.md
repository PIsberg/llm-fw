[llm-fw](../../README.md) > [Documentation](../README.md) > Plans > AI Gateway Custom Modules & Token Pruner

# Implementation Plan: AI Gateway Custom Modules & Token Pruner

This implementation plan delivers the feature requested in [Issue #340](https://github.com/PIsberg/llm-fw/issues/340): an extensible gateway module system, the Token Pruner / Cost Optimizer module with a smart content-aware pruning engine, dynamic dashboard opt-in/opt-out, and live real-time token savings visualization without web page refreshes.

---

## Phase 1: Configuration & Types
1. **Extend `src/types.ts`**:
   - Add `TokenPrunerConfig`:
     ```typescript
     export interface TokenPrunerConfig {
       enabled: boolean;
     }
     ```
   - Add `ModulesConfig` to `Config`:
     ```typescript
     export interface ModulesConfig {
       enabled: boolean;
       tokenPruner: TokenPrunerConfig;
     }
     ```
   - Add `ModuleEvent` interface for real-time telemetry:
     ```typescript
     export interface ModuleEvent {
       id: string;
       timestamp: string;
       moduleId: string;
       moduleName: string;
       target: string;
       path: string;
       tokensOriginal: number;
       tokensPruned: number;
       tokensSaved: number;
       percentSaved: number;
       totalTokensSaved: number;
       overallPercentSaved: number;
     }
     ```
2. **Update `src/config/config.ts`**:
   - Add default configuration under `DEFAULT_CONFIG`:
     ```typescript
     modules: {
       enabled: true,
       tokenPruner: {
         enabled: true,
       },
     },
     ```
   - Support environment variable overrides:
     - `LLM_FW_MODULES_ENABLED`
     - `LLM_FW_TOKEN_PRUNER_ENABLED`

---

## Phase 2: Module Core Framework & Registry
1. **Create `src/modules/types.ts`**:
   - Define `GatewayModule`, `GatewayModuleContext`, `ModuleTransformResult`, and `ModuleStats`.
   - Support optional asynchronous transformations (`Promise<ModuleTransformResult> | ModuleTransformResult`).
2. **Create `src/modules/registry.ts`**:
   - Implement `ModuleManager`:
     - Maintain an ordered list of registered modules.
     - `register(module: GatewayModule): void`
     - `getModule(id: string): GatewayModule | undefined`
     - `listModules(): GatewayModule[]`
     - `transformRequest(body: string, ctx: GatewayModuleContext): Promise<{ body: string; modified: boolean; events: ModuleEvent[] }>`
     - Aggregate cumulative metrics across modules (`totalTokensOriginal`, `totalTokensPruned`, `totalTokensSaved`, `overallPercentSaved`).
     - Support runtime enabling/disabling of modules.

---

## Phase 3: Token Pruner & Whitespace Optimizer
1. **Create `src/modules/builtin/tokenPruner.ts`**:
   - Implement `TokenPrunerModule implements GatewayModule`.
   - Unified Smart Pruning Logic:
     - `pruneText(text: string): string`
     - Parse markdown code fences (```...``` and `...`) to isolate code blocks.
     - Detect language tag:
       - Indentation-sensitive (`python`, `yaml`, `toml`, unlabelled): preserve indentation; trim line-end trailing whitespace only.
       - Brace-delimited (`json`, `js`, `ts`, `c`, `go`, etc.): collapse trailing line whitespace, redundant blank lines, and safe indentation.
     - Outside code blocks (natural prose):
       - Collapse runs of horizontal spaces/tabs `[^\S\r\n]+` to a single `' '`.
       - Collapse 3+ newlines `(\r?\n\s*){3,}` to `\n\n` (2 newlines).
       - Trim trailing spaces on each line.
       - Trim leading and trailing outer whitespace of the prompt.
     - Embedded JSON blocks: detect JSON arrays/objects and minify (`JSON.stringify(JSON.parse(...))`).
   - Provider-neutral message payload walker:
     - Detect and traverse text fields in OpenAI (`messages[].content`), Anthropic (`messages[].content`, `system`), Gemini (`contents[].parts[].text`), Cohere (`message`, `chat_history`), and Bedrock.
     - Fallback: if unrecognized JSON schema, scan string values in message-like keys.
   - Token calculation:
     - Fast estimation formula: `estimateTokens(str)` matching `QuotaManager` (~4 chars per token).
     - Calculate `saved = tokensBefore - tokensAfter`.
     - Record metrics and generate `ModuleEvent` if `saved > 0`.

---

## Phase 4: Proxy & Gateway Pipeline Integration
1. **Integrate into `src/proxy/proxy.ts`**:
   - Initialize `ModuleManager` in `ProxyServer.constructor`.
   - In `handleRequest`:
     - Run after initial DoS rate checks.
     - When `this.config.modules.enabled && isLlmRequest`:
       - Execute `moduleManager.transformRequest(body, ctx)`.
       - If `modified`: update `bodyBuf = Buffer.from(newBody, 'utf-8')` and `body = newBody`.
       - If observe mode is active (`enforcement === 'observe'`), record metrics but keep `bodyBuf` unmodified (dry-run).
       - Emit generated `ModuleEvent`s to `EventBus`.
     - Forward optimized `bodyBuf` upstream.
2. **Integrate into `src/gateway/gateway.ts`**:
   - In `GatewayServer.screen`:
     - If `this.config.modules.enabled && getParser(path) !== null`:
       - Run `moduleManager.transformRequest(text, ctx)`.
       - If modified and not observing: update `text` and `bodyBuf`.
       - Broadcast module savings events via `EventBus`.

---

## Phase 5: EventBus, Metrics & SSE Broadcasting
1. **Update `src/dashboard/eventBus.ts`**:
   - Add `emitModuleEvent(event: Omit<ModuleEvent, 'id' | 'timestamp'>): ModuleEvent`.
   - Maintain a rolling ring buffer of recent `ModuleEvent`s.
   - Broadcast over the active `/events` stream with event tag `event: module`.
   - Ensure new subscribers receive the current aggregated totals upon connection.
2. **Update `src/dashboard/metrics.ts`**:
   - Register Prometheus counters and gauges:
     - `llmfw_module_tokens_saved_total{module="token_pruner"}`
     - `llmfw_module_tokens_original_total{module="token_pruner"}`
     - `llmfw_module_requests_total{module="token_pruner"}`

---

## Phase 6: Dashboard Server API & Dynamic Settings
1. **Update `src/dashboard/server.ts`**:
   - **`SettingsView`**: Add `tokenPruner: boolean`.
   - **`BOOL_SETTERS`**: Add `tokenPruner: (c, v) => { (c.modules ??= { enabled: true, tokenPruner: { enabled: true } }).tokenPruner.enabled = v }`.
   - **`toPersistedPartial`**: Include `modules: { enabled: ..., tokenPruner: ... }`.
   - **`GET /api/modules`**: Return all registered modules, their statuses, and live statistics.
   - **`POST /api/modules`**: Dedicated endpoint to toggle individual modules.

---

## Phase 7: Dashboard UI (Real-time Counters, Toggle & Live Ticker)
1. **Header Stats Metric**:
   - Add a high-visibility stat card:
     - Label: **TOKENS SAVED**
     - Large value: `tokensSavedTotal` (e.g., `45,210`) with dynamic counter animation.
     - Subtext: `XX.X% saved` in vivid green (`#2e7d32`).
2. **Modules View / Segmented Tab**:
   - Add a new tab: **Modules & Cost Optimizer**.
   - Module Card for **Token Pruner / Cost Optimizer**:
     - Clean toggle switch: `[ON / OFF]` connected to `/api/settings` (instant, no reload).
     - Live KPI cards: Total Saved, Original Tokens, Savings Ratio.
     - **Live Activity Stream**: Real-time table/ticker of processed requests showing:
       - Target host & endpoint
       - Original tokens vs Pruned tokens
       - Savings badge (e.g. `-142 tokens (-18.2%)`)
       - Timestamp
3. **Vanilla JS Real-Time SSE Handler**:
   - Handle SSE incoming messages:
     ```javascript
     es.addEventListener('module', (e) => {
       const ev = JSON.parse(e.data);
       updateSavingsDisplay(ev);
       animateCounter('stat-tokens-saved', ev.totalTokensSaved);
       prependModuleLog(ev);
     });
     ```
   - Pulse animation on the counter when new tokens are saved for dramatic effect.

---

## Phase 8: Testing Strategy
1. **Unit Tests (`test/modules/`)**:
   - `test/modules/tokenPruner.test.ts`:
     - Test duplicate space and tab collapsing.
     - Test newline collapsing (preserving 2 newlines).
     - Test markdown code blocks preservation (` ```python\n    def foo():\n        pass\n``` `).
     - Test inline code blocks (`` `a    b` ``).
     - Test embedded JSON minification.
     - Test OpenAI, Anthropic, Gemini, Cohere, Bedrock payload structures.
     - Test token estimation accuracy and edge cases (empty text, non-string fields).
   - `test/modules/registry.test.ts`:
     - Test module registration, dispatch ordering, enablement toggles, and cumulative stats calculation.
2. **Integration Tests**:
   - `test/dashboard/modules.test.ts`:
     - Test `GET /api/modules` and `POST /api/settings` for module toggles.
     - Verify persistence to config file and immediate in-memory effect.
   - `test/proxy/proxy.test.ts` & `test/gateway/gateway.test.ts`:
     - Verify requests sent through proxy/gateway have whitespace pruned before reaching upstream.
     - Verify `Content-Length` header is correctly recalculated for rewritten payloads.
     - Verify observe mode does not rewrite the upstream body.
3. **E2E Tests (`test/dashboard/`)**:
   - Playwright test verifying the live counter animates upon receiving a pruned request without page refresh.

---

## Phase 9: Documentation & Changelog
1. Update `docs/README.md` (already indexed).
2. Document the keys in `docs/guides/configuration.md` (a paragraph next to its siblings, plus the generated environment-variable table). A separate `docs/guides/cost-optimizer.md` was planned and not written: one paragraph covers it.
3. Add entry in `CHANGELOG.md` under `## [Unreleased]`.

---

## Review revisions

The first cut was reviewed before it was committed. What changed, each with
a test that was seen failing first:

| Finding | Change |
| --- | --- |
| Enabled by default, so every upgraded install would rewrite prompts | `modules.tokenPruner.enabled` defaults to `false` (Phase 1's `enabled: true` above is superseded) |
| The module copied `enabled` at construction, so a hot-reloaded `config.json` never reached it although `hotReload.ts` lists the key as warm | The module holds a reference to `config.modules.tokenPruner` and reads it per request |
| Leading indentation was collapsed outside fences: nested markdown lists and unfenced Python lost their structure, and the blank-line regex swallowed the next line's indent | Indentation is kept; only interior runs collapse |
| Embedded-JSON regex was quadratic: 92, 363 and 1440 ms at 40, 80 and 160 KB | Linear table lookup plus a `JSON.parse` budget of 4x the input |
| Savings counted JSON re-serialisation of the envelope (62 "tokens" where the text shrank by 11) | Counted on the examined text fields |
| Totals counted only requests the pruner changed, so the percentage left clean requests out of its denominator (found live: a Claude Code request had 5 of 16,811 tokens to prune) | Every request with prompt text counts toward the totals |
| A module that threw failed the request | `ModuleManager` fails open per module |
| Observe mode reported savings that never happened | Dry run; events carry `applied: false`; the header says "would be saved (observe)" |
| `POST /api/modules` answered 200 for an unknown id | 404 |
| `LLM_FW_MODULES_ENABLED` and `LLM_FW_TOKEN_PRUNER_ENABLED` were missing from the generated reference, so `test/config/config-reference.test.ts` failed | Entries rewritten in the `if (c.x)` shape the generator parses, table regenerated |

Phase 3's per-language fence handling (compressing brace-delimited code) was
not built: every fence is preserved. The Playwright counter test in Phase 8
and the Modules tab in the spec's section 6.2 were not built either; both
are follow-up issues.
