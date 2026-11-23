[llm-fw](../../README.md) > [Documentation](../README.md) > MCP Monitoring & Tool Firewall

# MCP Monitoring & Tool Firewall

As AI agents increasingly rely on the **Model Context Protocol (MCP)** and local tool execution, securing what the LLM is allowed to execute locally is critical. The firewall natively intercepts the JSON-RPC tool schemas flowing between your agent and the upstream LLM API to provide four layers of defense:

### 1. Definition Enforcement (Outbound)
Agents often expose more tools than necessary (e.g. wildcard filesystem access). `llm-fw` intercepts the `tools` array exposed in the API request and refuses the request (`422`, with the reason in the body) if the agent advertises a tool on `mcp.blockedTools` (by default `execute_command` and `delete_database`, matched by exact name) to the LLM. A tool on that list is refused by name before the command guardrails below ever see its arguments, so drop it from the list if you would rather have its commands scanned.

### 2. Invocation Blocking (Inbound Streaming Defense)
If the LLM decides to use a tool, it returns the `tool_use` payload to the agent. `llm-fw` inspects every inbound response of a recognised LLM endpoint **before any tool bytes reach the agent**, including follow-up turns whose request carries no `tools` array (Claude Code 2.1 sends its tools on a session's first request only), OpenAI Responses API streams (`/v1/responses`, and ChatGPT's `/backend-api/codex/responses`, which Codex CLI uses and which sends no `Content-Type`; an untyped LLM response is classified by its first bytes), and rather than dropping the connection (which would surface as an opaque network error), it **surgically strips the blocked tool call and lets the rest of the turn through**:

- **Non-streaming JSON:** the full body is buffered, the blocked `tool_use` blocks are removed, and a short `[llm-fw blocked tool call(s): …]` text note is inserted. If no tool calls remain, `stop_reason` is downgraded (`tool_use` → `end_turn`) so the agent ends its turn cleanly. Allowed tool calls in the same response are preserved untouched.
- **Streaming SSE:** the response is gated event-by-event. The tool name arrives in the `content_block_start` event (before any argument bytes), so a blocked block's start/deltas/stop are swallowed and the terminating `stop_reason`/`finish_reason` is downgraded — the agent never sees the call. An execution tool's command arrives after its name, in later delta frames, so such a call is held until its arguments are complete (Anthropic `content_block_stop`, OpenAI the chunk with `finish_reason`), checked against the guardrails below on the assembled command, and then dropped or released in order. Text before it streams as before; text after it waits for the decision. Before #529 the decision was taken on the empty arguments of the name frame, so a streamed command was never scanned.

This works across Anthropic (`tool_use`, and the server-side `server_tool_use` and MCP connector `mcp_tool_use` blocks, whose result blocks are dropped with them), OpenAI-compatible, OpenAI Responses, Gemini and Google Cloud Code (Gemini CLI, Antigravity), Bedrock Converse and Cohere JSON response shapes. Streamed, the Anthropic, OpenAI, Responses, Gemini, Cloud Code and Cohere formats are gated, framed with CRLF, LF or CR line ends alike: Cohere v2 (`/v2/chat`) holds an execution tool from `tool-call-start` to `tool-call-end` and downgrades `finish_reason` `TOOL_CALL` to `COMPLETE`, and Cohere v1 (`/v1/chat`), which streams newline-delimited JSON (`application/stream+json`), is held from its first `tool-calls-chunk` to `tool-calls-generation` and a blocked call is removed from its chunks, that event and `stream-end` (#881). A tool block that starts while an execution tool's block is held is checked when the held one is decided, and a streamed event that grows past 16 MiB without ending is dropped unread and reported as a block. Bedrock's binary event streams (`converse-stream` and `invoke-with-response-stream`, `application/vnd.amazon.eventstream`) are gated too (#882): each frame is read as the Anthropic event it stands for (a Converse `toolUse` block, or the Anthropic event an InvokeModel `chunk` carries) and decided by the same gate; frames it passes go out byte for byte, a blocked call's frames are dropped, the stop reason is rewritten with fresh checksums, and a frame whose checksum or length does not match ends the stream and is reported as a block. Before #851, an OpenAI stream's arguments were scanned as raw JSON text (a command ending right before its closing quote matched no rule), Gemini and Cloud Code streams went to the Anthropic gate and passed every call, Bedrock and Cohere JSON bodies came back unchanged, and a CRLF stream was held whole and forwarded unread.

### 3. Execution-Context Security Guardrails (Inbound Argument Scanning)
For known execution tools (`execute_command`, `bash`, `ctx_shell`, `powershell`, `shell`, `run_shell_command`, and Codex CLI's `shell_command`, `exec_command`, `local_shell` and code-mode `exec`, whose JavaScript input is scanned as text; matched in any capitalisation, so Claude Code's `Bash` and `PowerShell` are included), `llm-fw` runs a context-aware heuristic check on the command arguments. If the command matches any destructive patterns, it is blocked. The block triggers a non-fatal warning alert in the dashboard and strips the tool use, replacing it with a placeholder note so the agent turn terminates cleanly.

The guardrails cover 4 key threat categories:
- **Category A: File System Devastation** — recursive deletes of root, home, a bare glob, a drive root or a top-level system directory (e.g. `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `rm -rf "$HOME"`, `rm -rf *`, `rm -rf /c/`, `rm -rf /etc`), system drives wiping, disk formatting, and mass permission alterations (`chmod -R 777`). A recursive delete of a deeper path, absolute or relative (`rm -rf ./build`, `rm -rf /tmp/run-42`, `rm -rf ~/.m2/repository/com/example`), is routine cleanup and passes.
- **Category B: Reverse Shells & Network Pivots** — piped remote script execution (`curl ... | bash`), netcat listeners, and unauthorized POST requests targeted at exfiltrating sensitive files (e.g. `/etc/passwd`, `.env`, `.git/config`).
- **Category C: Process & Resource Exhaustion** — fork bombs (`:(){ :|:& };:`) and mass termination commands (`killall -9`).
- **Category D: Developer Tools & Infrastructure** — forced git pushes/resets, database annihilation (`DROP DATABASE`, `TRUNCATE TABLE`), and cloud teardowns (`terraform destroy`, `aws ... delete-...`). A force push is a flag token anywhere after `git push` on the line: `--force`, or a short flag starting with a lowercase `f` (`-f`, `-fu`), quoted or escaped included. A branch name such as `fix/login-form`, a long flag such as `--follow-tags`, or another program's `-F` later on the same line (`awk -F'\t'`) is not a force push, and neither is `--force-with-lease`, which refuses to overwrite a remote ref it has not seen. `git reset --hard` stays blocked in any form: it discards uncommitted work that nothing can recover.

A heredoc body that is written out as data is not scanned as a command: one read by `cat`, `tee`, `git` or `gh` (a file being written, a commit message, a PR body), on an opening line that pipes nothing onward and names no shell, interpreter or database client, into a file that no later command on the same call runs. So `cat > Test.java <<'EOF'` with `DROP TABLE` in a string literal passes, while `psql <<'SQL'`, `cat <<'EOF' | sh`, `python - <<'EOF'` and `cat > x.sh <<'EOF' ... bash x.sh` are all scanned. A PowerShell here-string (`@'...'@`, `@"..."@`) that `Set-Content`, `Add-Content` or `Out-File` writes to a file the call does not then run is treated the same way.

Quoted text is scanned like the rest of the line, so `grep -rn "git reset --hard" src/` is refused. Treating a quoted argument as data was tried for #298 and removed: every regex reading of shell quoting diverged from the shell's somewhere (`grep \"x; git reset --hard; echo \"` runs the reset, because the shell reads `\"` as a literal quote), and replaying 50,408 real Claude Code shell calls it cleared none.

Two limits are deliberate. Text inside a body fed to an interpreter (`python - <<'EOF'`) is scanned, string literals included, because a string literal is exactly what `os.system` or `subprocess` runs. And a script written in one tool call and run in the next is outside what a per-call check can see, as is a file written with an agent's own file-writing tool.

### 4. Result Scanning & DLP (Outbound)
When a safe tool returns data (e.g., `read_file`), that result is sent back to the LLM in the next turn. `llm-fw` extracts the `tool_result` content and subjects it to the standard Data Loss Prevention (DLP) engine. If a tool accidentally reads your `~/.aws/credentials`, the keys are redacted before the request is forwarded under the default `dlp.mode: redact`. Under `dlp.mode: block` the whole request is refused instead; this check does not withhold one tool result the way detection does, so the refusal repeats on every later turn of that session until the tool result leaves the history. `mcp.auditOnly: true` turns that refusal into a warn.

The same text goes through the injection pipeline on the `tool_result` surface. An MCP tool returns its content as an array of blocks; their text is read as the model reads it, one block per line with its own line breaks, and only a block with no text (an image, a `json` block) is scanned as JSON.

### Configuration

```json
{
  "mcp": {
    "enabled": true,
    "blockedTools": ["execute_command", "delete_database"],
    "auditOnly": false,
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
