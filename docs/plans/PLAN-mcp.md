# Implementation Plan: MCP Monitoring & Security

## Phase 1: Configuration & Types
1. **Update `src/types.ts`**:
   - Add `McpConfig` interface to `Config` with fields like `enabled: boolean`, `blockedTools: string[]`, `auditOnly: boolean`.
   - Update `EventBus` types to include `kind: 'mcp'` and `stage: 'mcp-filter'`.
2. **Update `src/config/config.ts`**:
   - Add default configuration for `mcp` settings.

## Phase 2: Payload Parsers
Currently, `src/detection/parsers.ts` abstracts LLM API payloads (e.g., Anthropic vs OpenAI).
1. **Extend `PayloadParser` interface**:
   - Add methods to extract `tools` definitions.
   - Add methods to extract `tool_use` (invocations).
   - Add methods to extract `tool_result` (outputs).
2. **Implement for Anthropic/OpenAI**:
   - Anthropic: Extract `content` blocks of type `tool_use` and `tool_result`.
   - OpenAI: Extract `tool_calls` and `tool_choice` from messages.

## Phase 3: The MCP Scanner
1. **Create `src/detection/mcp/scanner.ts`**:
   - Implement `McpScanner` class.
   - **Method `checkToolDefinitions(tools: any[])`**: Ensure the agent isn't exposing unauthorized tools to the LLM.
   - **Method `checkToolInvocation(toolName: string, args: any)`**: Validate against `blockedTools` list. If the tool is permitted, optionally run arguments through the heuristic pipeline (e.g., check for path traversal in `read_file`).
   - **Method `checkToolResult(toolName: string, result: string)`**: Hook into the existing `DlpScanner` to ensure secrets are not exfiltrated in tool results.

## Phase 4: Proxy Integration
Integrating this into `src/proxy/proxy.ts` requires intercepting both the request and response.
1. **Outbound Interception (Request)**:
   - In `handleRequest`, after parsing the request body, extract `tools` and `tool_result`.
   - Pass them to `McpScanner`. If a block occurs, return a 403 immediately and drop the request.
2. **Inbound Interception (Response)**:
   - **Challenge**: LLM responses are typically streamed. A `tool_use` JSON block might be chunked across multiple TCP frames.
   - **Solution**: Implement a chunk buffer/parser in `forwardRequest` that detects when a `tool_use` block starts, buffers until the JSON is complete, and runs it through `McpScanner`.
   - If blocked, rewrite the response chunk or drop the connection before the final chunk reaches the local agent.

## Phase 5: Dashboard Updates
1. **Update `src/dashboard/server.ts`**:
   - Add a new "MCP Tool Usage" stats counter.
   - Update CSS to include `.chip-mcp` (e.g., a teal badge for MCP events).
   - In the drawer view, format `tool_use` payloads distinctly from standard chat prompts.
2. **Dashboard UI (`index.html`)**:
   - Add an MCP tab to visualize the most frequently used tools and potentially sensitive arguments.

## Phase 6: Execution-Context Security Guardrails (Destructive Command Blocking)
Implements SPEC-mcp §6 — scanning the *arguments* of execution tools for catastrophic commands, on top of the name-based allow/deny policy.
1. **Create `src/detection/mcp/commands.ts`**:
   - Implement a pure `CommandScanner` with four toggleable rule categories (A: File System Devastation, B: Reverse Shells & Network Pivots, C: Process & Resource Exhaustion, D: Developer Tools & Infrastructure).
   - `scan(command, enabledCategories)` returns `{ isBlocked, category, reason }`. Patterns must be scoped to avoid false positives on routine commands (e.g. `chown -R user ./dir`, `rm -rf ./build`).
2. **Wire into `McpScanner.checkToolInvocation`**:
   - Only scan arguments of known execution tools (`execute_command`, `bash`, `ctx_shell`, `powershell`); ignore arbitrary text payloads to avoid false positives.
   - `extractCommandString` pulls the command from recognized keys, falling back to scanning *all* string args so a payload can't hide behind a benign field.
   - The name-based `blockedTools` check runs first and takes precedence over the content scan.
   - Honor `guardrailsEnabled` / `guardrailsCategories`; under `auditOnly`, surface a flagged-pass so the proxy emits a `warned` event instead of silently passing.
3. **Config & types** (`src/types.ts`, `src/config/config.ts`):
   - Add `guardrailsEnabled` and `guardrailsCategories` to `McpConfig`; add the `mcpRule` field to `BlockEvent`.
   - Support the `LLM_FW_MCP_GUARDRAILS_ENABLED` env override.
4. **Response-side enforcement** (`src/detection/mcp/responseGate.ts`):
   - Run the invocation check on every `tool_use` parsed from non-streaming JSON and both SSE gates, stripping/gating blocked calls (see DESIGN-mcp-response.md).
5. **Playground** (`src/dashboard/server.ts`):
   - Add a "Security Guardrails" tab: a simulated-tool selector, per-category toggles, and a command input that posts to the `guardrails` analyze endpoint.
