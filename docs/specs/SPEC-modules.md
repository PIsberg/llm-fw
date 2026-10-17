[llm-fw](../../README.md) > [Documentation](../README.md) > Specifications > AI Gateway Custom Modules & Token Pruner

# Specification: AI Gateway Custom Modules & Token Pruner

## 1. Overview
As an AI proxy and gateway, `llm-fw` sits directly on the request/response path between AI clients (agents, applications, developers) and upstream LLM providers (Anthropic, OpenAI, Gemini, Cohere, Bedrock, etc.). While its primary function is security screening (prompt injection firewall, DLP, DoS protection, MCP tool validation), an enterprise AI gateway also provides traffic optimization, cost governance, telemetry enrichment, and payload transformations.

This specification introduces:
1. **Custom Gateway Modules Framework**: A lightweight, pluggable middleware pipeline that allows operators to extend gateway behavior (inspecting, transforming, or augmenting requests and responses).
2. **First-Party Module: Token Pruner / Cost Optimizer**: A smart optimization module that strips redundant whitespace and minifies embedded data from prompts to lower token consumption, calculate live savings, and reduce LLM inference costs without breaking code or prompt syntax.
3. **Live Dashboard Control & Real-Time Visualization**: Instant opt-in / opt-out controls for modules during a live running session without service restart, paired with real-time SSE-streamed metrics updating live token savings, cumulative totals, and percentage savings without requiring browser refresh.

---

## 2. Goals & Non-Goals

### 2.1 Goals
- **Pluggable Module Interface**: Provide a well-defined `GatewayModule` contract supporting request/response hooks, lifecycle methods, configuration schemas, and module telemetry.
- **Dynamic Live Opt-in / Opt-out**: Enable or disable any module during runtime through the dashboard UI and REST API (`/api/settings` and `/api/modules`) with zero server restarts; persist toggle state to `~/.llm-fw/config.json`.
- **Unified Smart Optimization**: A single, zero-configuration pruning engine, opt-in (`modules.tokenPruner.enabled`, default `false`) because it rewrites the prompt text the provider receives:
  - Collapses interior runs of spaces and tabs to one space. Leading indentation is kept on every line, because nested markdown lists and code pasted without a fence depend on it.
  - Collapses a run of blank lines to one blank line.
  - Trims trailing whitespace on lines and outer prompt margins.
  - Minifies embedded multiline JSON objects and arrays.
  - Leaves fenced code blocks alone apart from trailing whitespace.
- **Zero-Refresh Real-Time Visualization**: Broadcast per-request savings over the existing Server-Sent Events (SSE) stream and immediately update the live counter and savings percentage in the dashboard header.
- **Both surfaces**: Forward proxy (`src/proxy/`) and reverse gateway (`src/gateway/`). The pruner reads the `prompt` and `system` text slots `collectTextSlots` finds (OpenAI chat, the Responses API, Anthropic, Gemini, a legacy `prompt`); tool output is left to its own modules. Other shapes, such as Bedrock Converse parts without a `type`, pass through untouched.
- **Later modules**: Each further token-saving technique is its own module with its own switch, listed with its trade-offs in [Token savings](../guides/token-savings.md).
- **Zero External Dependencies**: Maintain the project's zero-dependency ethos by implementing lightweight whitespace normalization and token estimation without adding heavy tokenizer packages.

### 2.2 Non-Goals
- **Destructive Semantic Truncation** in the token pruner: dropping user turns, chopping middle sentences, or aggressive lossy summarization that risks altering user intent or model accuracy. Two later modules do cut deliberately, each opt-in and documented as lossy: the tool result truncator and the history window.
- **Arbitrary Sandboxed Plugin Runtimes**: Modules are compiled TypeScript classes within the firewall codebase rather than untrusted external runtime scripts.
- **Bypassing Security Screening**: Modules run cooperatively with the security pipeline; transformed payloads remain fully protected by DLP and prompt injection scanning.

---

## 3. The Smart Pruning Algorithm

The Token Pruner operates with a single content-aware **Smart** engine:

```
+-------------------------------------------------------------------------+
|                              Raw Payload                                |
|   {"messages": [{"role": "user", "content": "Hello    world\n\n\n```... |
+-------------------------------------------------------------------------+
                                     │
                                     ▼
         Extract text content from provider-specific message schema
                                     │
                                     ▼
        Token Pruner Scanner: Split text into Code Fences vs Plain Text
         ┌───────────────────────────────────────┬──────────────────────┐
         ▼                                       ▼                      ▼
  [Outside Code Fences]               [Fenced Code: Python/YAML]  [Embedded JSON]
  - Collapse [ \t]+ to ' '            - Preserve indentation      - Safe minify
  - Collapse \n{3,} to \n\n           - Trim line trailing spaces   (strip formatting
  - Trim line trailing whitespace                                   spaces/newlines)
  - Trim outer leading/trailing spaces
         └───────────────────────────────────────┴──────────────────────┘
                                     │
                                     ▼
                      Reassemble Optimized Content
                                     │
                                     ▼
                  Estimate Tokens Saved: (Before - After)
                                     │
                                     ▼
             Emit Module Event (SSE) -> Forward Optimized Body
```

### Detailed Rules:
1. **Natural Language / Prose** (everything outside a code fence):
   - Leading indentation of each line is kept as written.
   - After it, runs of spaces and tabs collapse to a single space.
   - A run of blank lines (whitespace-only lines count) collapses to one blank line, so 3 or more newlines become 2.
   - Trailing horizontal whitespace on each line is trimmed, and so is the outer leading and trailing whitespace of the whole text.
   - CRLF line endings become LF.
2. **Embedded JSON**:
   - A JSON object or array that opens at the start of a line and closes on a later line holding only the matching bracket is minified (`JSON.stringify(JSON.parse(raw))`) when it parses. Anything that does not parse is left as prose.
   - The scan is linear: the next closing line is found from a table, and the text handed to `JSON.parse` is capped at four times the input. The first cut used a lazy regex that took 1.4 s of event-loop time on a 160 KB prompt of lines starting with `{`.
3. **Fenced Code Blocks** (` ```lang ... ``` `):
   - Indentation and blank lines are preserved for every language, labelled or not. Only trailing whitespace on each line is trimmed. Compressing brace-delimited languages was considered and not built: the saving is small and a heredoc or a multiline string inside such a block is whitespace-sensitive too.

---

## 4. Architecture & Data Flow

### 4.1 Gateway Module Interface (`src/modules/types.ts`)
```typescript
export interface GatewayModuleContext {
  target: string;
  method: string;
  path: string;
  isLlmRequest: boolean;
  parser: PayloadParser | null;
  sessionKey?: string;
  tenant?: string;
  /** Observe mode: the original body is forwarded whatever the module returns. */
  dryRun?: boolean;
}

export interface ModuleTransformResult {
  body: string;
  modified: boolean;
  metadata?: Record<string, unknown>;
  events?: ModuleEvent[];
}

export interface ModuleStats {
  id: string;
  name: string;
  enabled: boolean;
  totalInvocations: number;
  tokensOriginal: number;
  tokensPruned: number;
  tokensSaved: number;
  percentSaved: number;
  recentEvents: ModuleEvent[];
}

export interface GatewayModule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  enabled: boolean;

  /** Transform request body prior to upstream dispatch. */
  transformRequest(
    body: string,
    ctx: GatewayModuleContext
  ): Promise<ModuleTransformResult> | ModuleTransformResult;

  /** Return live statistics for dashboard telemetry. */
  getStats(): ModuleStats;

  /** Reset in-memory statistics. */
  resetStats?(): void;
}
```

### 4.2 Interception Points in Request Lifecycle
The module pipeline integrates into both `ProxyServer.handleRequest` (`src/proxy/proxy.ts`) and `GatewayServer.screen` (`src/gateway/gateway.ts`):

1. **Body buffered**: the complete request body is read (and the body-size limit applied) before any module runs.
2. **Module Transformation**: If `config.modules.enabled` and the path has a payload parser, pass `body` through registered and enabled modules in registration order:
   - A module that throws or rejects is logged and skipped; the request continues with the body as the previous module left it. Modules fail open, like the judge.
   - A module may also implement `observeResponse`. When an enabled module does, the proxy and the gateway wrap the client response with `tapResponse` (`src/modules/responseTap.ts`), which copies what is written, up to `proxy.maxBodyBytes`, and hand the capture over once the response has ended. The usage meter reads provider-reported usage this way.
   - A module may implement `respond`, asked once every request-side gate (DLP, detection, MCP checks) has passed the request, with the body that would go upstream. The first enabled module that returns a response answers the client with it (`writeCapturedResponse`) and the provider is never contacted; one that throws is logged and the request is forwarded. The response cache answers this way, and never under observe mode. On the proxy the answer goes through `replayStoredResponse`, which runs the response-side gates (MCP policy, exfil, tool-use and harm scans) on the stored body under the current policy, exactly as a live response gets them.
   - `collectTextSlots` (`src/modules/payload.ts`) lists every text field of the request, labelled `prompt`, `system`, `tool_result` or `tool_definition`, across OpenAI chat, the Responses API, Anthropic and Gemini. `TokenPrunerModule` prunes the `prompt` and `system` slots and leaves tool output alone.
   - It sums `estimateTokens` over the text fields before and after pruning.
   - If any text changed, it updates its rolling stats and returns the re-serialised body.
   - In observe mode the caller passes `dryRun: true`, forwards the original body, and the event carries `applied: false`.
3. **Telemetry & Live Broadcasting**:
   - `EventBus.emitModuleEvent()` broadcasts a real-time event containing `tokensOriginal`, `tokensPruned`, `tokensSaved`, `percentSaved`, and cumulative counters.
   - Connected dashboard browsers receive the update via `/events` SSE immediately.
4. **Security Screening**:
   - DLP scans the pruned payload (redacts or blocks).
   - Detection pipeline scans the pruned payload (heuristics, embeddings, classifier, judge).
5. **Upstream Dispatch**:
   - Upstream LLM receives the optimized payload, incurring fewer input tokens.

---

## 5. Token Estimation & Savings Metrics

### 5.1 Token Estimation Algorithm
To remain fast and dependency-free while maintaining fidelity across OpenAI (cl100k/o200k), Anthropic, and Gemini tokenizers:
- `estimateTokens` in `src/modules/tokens.ts` walks the text once in the pieces a BPE pre-tokenizer would cut (letter, digit and punctuation runs, whitespace runs, line breaks) and charges each piece. A run of spaces is one token however long, which chars/4 got wrong: it overstated the pruner's saving on column-aligned tool output by 75% against cl100k and o200k. Measured errors and the fitting corpus are in the file's header comment; `test/modules/tokens.test.ts` pins five measured counts. `QuotaManager.estimateTokens` keeps ~4 characters per token for budgets.
- Counted on the prompt text the pruner examined, never on the request body. Re-serialising a pretty-printed JSON envelope shrinks the body by bytes the model never sees as tokens; the first cut counted those and reported 62 tokens saved where the prompt text shrank by 11.
- `tokensSaved = Math.max(0, tokensBefore - tokensAfter)`.
- `percentSaved = tokensOriginal > 0 ? ((tokensSaved / tokensOriginal) * 100) : 0`. The denominator is the examined text, so tool results, images and tool definitions, which are billed but not pruned, are not in it.

### 5.2 Metrics Model
`GET /api/modules` returns `ModuleManager.getSummaryStats()` (`totalTokensOriginal`, `totalTokensPruned`, `totalTokensSaved`, `overallPercentSaved`, cumulative since startup and in memory only) plus each module's `getStats()` and `description`. `applied` is the newest event's flag (absent before any event): `false` means the totals were last added to by an observe-mode dry run, and the header then says "would be saved (observe)" however the page was loaded. The totals include requests with nothing to prune, so the percentage is over all prompt text examined; an event is emitted only for a request that changed. Every `module` SSE event carries the per-request figures and the module's running totals.

---

## 6. Live Dashboard & Settings Integration

### 6.1 Live Opt-in / Opt-out
- Added to `SettingsView` (`src/dashboard/server.ts`):
  ```typescript
  interface SettingsView {
    // ... existing toggles ...
    tokenPruner: boolean;
  }
  ```
- Mutating `config.modules.tokenPruner.enabled` takes effect on the very next request with no restart. The module holds a reference to that config object rather than a copy, so the Settings toggle, `POST /api/modules` and a hot-reloaded `config.json` all reach it.
- Written to `~/.llm-fw/config.json` via `persistSettings()`.
- `POST /api/modules` takes `{ "id": "<module id>", "enabled": true|false }`, needs the same JSON content-type and same-origin check as the other state-changing routes, and answers 404 for an id that is not registered.

### 6.2 Real-time Dashboard UI Components
1. **Header Stats Metric Card**:
   - Displays **TOKENS SAVED**:
     - Large bold counter: e.g. `124,530`
     - Live subtext: `18.6% saved`, or `% would be saved (observe)` when the last event was a dry run.
2. **Settings toggle**: `Token Pruner / Cost Optimizer` in the Cost & Abuse group.
3. **Modules tab** ([#341](https://github.com/PIsberg/llm-fw/issues/341)): one card per registered module with its enable toggle (`POST /api/modules`) and KPIs (tokens saved, original tokens, savings ratio, requests examined), and a Recent Activity table fed by the `module` SSE listener, newest first and capped at 200 rows: time, module, target, path, original and pruned tokens, and the saving, marked "would save" for a dry run. The table is rebuilt from the server's replay on every stream (re)connect, like the Events table. The cards refresh from `GET /api/modules` at most every 500 ms while events arrive.
4. **No-Refresh SSE Listener**:
   - Dashboard frontend `EventSource` handles incoming `type: 'module'` SSE messages:
     ```javascript
     es.addEventListener('module', (e) => {
       const data = JSON.parse(e.data);
       if (data.moduleId === 'token-pruner') {
         updateTokenPrunerStats(data);
       }
     });
     ```

---

## 7. Configuration Schema (`src/types.ts`)
```typescript
export interface TokenPrunerConfig {
  enabled: boolean;
}

export interface ModulesConfig {
  enabled: boolean;
  tokenPruner: TokenPrunerConfig;
}

export interface Config {
  // ... existing fields ...
  modules?: ModulesConfig;
}
```

Defaults: `modules.enabled: true`, `modules.tokenPruner.enabled: false`. Both are hot-reloadable.

Environment variable overrides:
- `LLM_FW_MODULES_ENABLED=true|false`
- `LLM_FW_TOKEN_PRUNER_ENABLED=true|false`

---

## 8. Threat & Correctness Considerations
| Scenario | Risk | Mitigation |
|---|---|---|
| **Code in Prompt** | Collapsing indentation breaks code, YAML and nested lists. | Fenced code is left alone; outside fences, leading indentation is kept on every line. Interior runs of spaces still collapse, so an unfenced string literal with aligned spaces changes. That is why the module is opt-in. |
| **Scan what is sent** | Detection and the provider could see different text. | DLP and detection run after the modules, on the body that is forwarded. Under observe mode they scan the original, which is also what is forwarded. |
| **Prompt Injection Evasion** | Pruning could hide or create an attack string. | Outside embedded JSON, pruning only collapses or removes whitespace and never joins two words. Minifying embedded JSON re-serialises it, which decodes `\uXXXX` escapes and normalises numbers (`1.0` becomes `1`); detection runs afterwards, so it sees the decoded form. Pruning does not undo letter-spacing (`i g n o r e`): single spaces stay. |
| **A broken module** | A module that throws drops every request. | `ModuleManager` catches, logs and skips it (fail open). |
| **Event-loop cost** | Pruning runs on every LLM request, on the event loop. | Linear scans only; a test pins 80,000 brace lines under 300 ms. |
| **Observing vs Enforcing** | In observe mode, should requests be rewritten? | No. With `enforcement: 'observe'` the module runs as a dry run, the original body is forwarded and the event says `applied: false`. |
