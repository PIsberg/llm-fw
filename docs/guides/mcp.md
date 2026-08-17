[llm-fw](../../README.md) > [Documentation](../README.md) > MCP Monitoring & Tool Firewall

# MCP Monitoring & Tool Firewall

As AI agents increasingly rely on the **Model Context Protocol (MCP)** and local tool execution, securing what the LLM is allowed to execute locally is critical. The firewall natively intercepts the JSON-RPC tool schemas flowing between your agent and the upstream LLM API to provide four layers of defense:

### 1. Definition Enforcement (Outbound)
Agents often expose more tools than necessary (e.g. wildcard filesystem access). `llm-fw` intercepts the `tools` array exposed in the API request and aborts the connection if the agent attempts to advertise a blocked tool (e.g., `execute_command`) to the LLM.

### 2. Invocation Blocking (Inbound Streaming Defense)
If the LLM decides to use a tool, it returns the `tool_use` payload to the agent. `llm-fw` inspects the inbound response **before any tool bytes reach the agent**, and rather than dropping the connection (which would surface as an opaque network error), it **surgically strips the blocked tool call and lets the rest of the turn through**:

- **Non-streaming JSON:** the full body is buffered, the blocked `tool_use` blocks are removed, and a short `[llm-fw blocked tool call(s): …]` text note is inserted. If no tool calls remain, `stop_reason` is downgraded (`tool_use` → `end_turn`) so the agent ends its turn cleanly. Allowed tool calls in the same response are preserved untouched.
- **Streaming SSE:** the response is gated event-by-event. The tool name arrives in the `content_block_start` event (before any argument bytes), so a blocked block's start/deltas/stop are swallowed and the terminating `stop_reason`/`finish_reason` is downgraded — the agent never sees the call.

This works across Anthropic, OpenAI-compatible, and Gemini response shapes.

### 3. Execution-Context Security Guardrails (Inbound Argument Scanning)
For known execution tools (`execute_command`, `bash`, `ctx_shell`, `powershell`), `llm-fw` runs a context-aware heuristic check on the command arguments. If the command matches any destructive patterns, it is blocked. The block triggers a non-fatal warning alert in the dashboard and strips the tool use, replacing it with a placeholder note so the agent turn terminates cleanly.

The guardrails cover 4 key threat categories:
- **Category A: File System Devastation** — recursive deletes (e.g. `rm -rf /`, `rm -rf *`), system drives wiping, disk formatting, and mass permission alterations (`chmod -R 777`).
- **Category B: Reverse Shells & Network Pivots** — piped remote script execution (`curl ... | bash`), netcat listeners, and unauthorized POST requests targeted at exfiltrating sensitive files (e.g. `/etc/passwd`, `.env`, `.git/config`).
- **Category C: Process & Resource Exhaustion** — fork bombs (`:(){ :|:& };:`) and mass termination commands (`killall -9`).
- **Category D: Developer Tools & Infrastructure** — forced git pushes/resets, database annihilation (`DROP DATABASE`, `TRUNCATE TABLE`), and cloud teardowns (`terraform destroy`, `aws ... delete-...`).

### 4. Result Scanning & DLP (Outbound)
When a safe tool returns data (e.g., `read_file`), that result is sent back to the LLM in the next turn. `llm-fw` extracts the `tool_result` content and subjects it to the standard Data Loss Prevention (DLP) engine. If a tool accidentally reads your `~/.aws/credentials`, the firewall blocks it from being uploaded.

### Configuration

```json
{
  "mcp": {
    "enabled": true,
    "blockedTools": ["execute_command", "delete_database", "eval"],
    "guardrailsEnabled": true,
    "guardrailsCategories": {
      "a": true,
      "b": true,
      "c": true,
      "d": true
    }
  }
}
```

Environment overrides:

| Variable | Effect |
|----------|--------|
| `LLM_FW_MCP_ENABLED` | `true`/`false` — enable or disable the MCP firewall |
| `LLM_FW_MCP_GUARDRAILS_ENABLED` | `true`/`false` — enable or disable execution-context command guardrails |

Detected events appear in the dashboard under the **MCP / Tool Use** badge with a distinct `mcp-filter` stage chip, logging both `PASSED` legitimate traffic and `BLOCKED` policy violations (with details on the triggered category rule in the event's `mcpRule` metadata).
