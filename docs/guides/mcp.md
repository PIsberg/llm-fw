[llm-fw](../../README.md) > [Documentation](../README.md) > MCP Monitoring & Tool Firewall

# MCP Monitoring & Tool Firewall

As AI agents increasingly rely on the **Model Context Protocol (MCP)** and local tool execution, securing what the LLM is allowed to execute locally is critical. The firewall natively intercepts the JSON-RPC tool schemas flowing between your agent and the upstream LLM API to provide four layers of defense:

### 1. Definition Enforcement (Outbound)
Agents often expose more tools than necessary (e.g. wildcard filesystem access). `llm-fw` intercepts the `tools` array exposed in the API request and refuses the request (`422`, with the reason in the body) if the agent advertises a tool on `mcp.blockedTools` (by default `execute_command` and `delete_database`, matched by exact name) to the LLM. A tool on that list is refused by name before the command guardrails below ever see its arguments, so drop it from the list if you would rather have its commands scanned.

### 2. Invocation Blocking (Inbound Streaming Defense)
If the LLM decides to use a tool, it returns the `tool_use` payload to the agent. `llm-fw` inspects the inbound response **before any tool bytes reach the agent**, and rather than dropping the connection (which would surface as an opaque network error), it **surgically strips the blocked tool call and lets the rest of the turn through**:

- **Non-streaming JSON:** the full body is buffered, the blocked `tool_use` blocks are removed, and a short `[llm-fw blocked tool call(s): …]` text note is inserted. If no tool calls remain, `stop_reason` is downgraded (`tool_use` → `end_turn`) so the agent ends its turn cleanly. Allowed tool calls in the same response are preserved untouched.
- **Streaming SSE:** the response is gated event-by-event. The tool name arrives in the `content_block_start` event (before any argument bytes), so a blocked block's start/deltas/stop are swallowed and the terminating `stop_reason`/`finish_reason` is downgraded — the agent never sees the call.

This works across Anthropic, OpenAI-compatible, and Gemini response shapes.

### 3. Execution-Context Security Guardrails (Inbound Argument Scanning)
For known execution tools (`execute_command`, `bash`, `ctx_shell`, `powershell`, `shell`, `run_shell_command`, matched in any capitalisation, so Claude Code's `Bash` and `PowerShell` are included), `llm-fw` runs a context-aware heuristic check on the command arguments. If the command matches any destructive patterns, it is blocked. The block triggers a non-fatal warning alert in the dashboard and strips the tool use, replacing it with a placeholder note so the agent turn terminates cleanly.

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
