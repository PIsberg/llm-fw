# Design: Correct MCP Response (Inbound) Interception

This supersedes Phase 4.2 of `PLAN-mcp.md`. The committed implementation of
response-side `tool_use` interception in `forwardRequest` is unsound and must be
replaced before the inbound half of the firewall can be trusted.

## 1. Why the current implementation is broken

In `forwardRequest`, response bytes are inspected inside `upstream.on('data')`
**after** two things have already happened:

1. `res.writeHead(statusCode, ...)` sent `200 OK` to the agent.
2. The first body slice (`bodyStart`, carved out of the same TCP segment as the
   headers) was already `res.write()`-en to the agent.

Consequences:

- **Non-streaming responses (`application/json`)**: the entire `tool_use` JSON
  often arrives in that first segment and is written via `bodyStart` *before* the
  `else` branch ever runs. The regex check never sees it. **The block is a silent
  no-op** — exactly the case `test-mcp.js`/`test-sinkhole.js` exercise.
- **Streaming responses (`text/event-stream`)**: you cannot un-send bytes already
  flushed. `res.destroy()` after a `200` + partial body yields a truncated/corrupt
  stream, and the agent has very likely already received the `tool_use` event and
  will act on it. Blocking-after-forwarding is not blocking.
- **Detection is a regex** (`/"(?:name|tool)":"([^"]+)"/`) that first-matches any
  `"name"` field and mutates the forwarded payload with an `__emitted__` sentinel.
  The correctly-written `parser.extractToolUses()` exists but is never called.

**Invariant we must restore:** a decision about a `tool_use` block must be made
*before* the bytes that convey that block are forwarded to the agent.

## 2. Strategy: decide-before-forward, branched by Content-Type

Once response headers are parsed we know `Content-Type`. Branch into three modes:

| Mode | Condition | Behaviour |
|------|-----------|-----------|
| **Passthrough** | not an LLM request, or `mcp` disabled, or unknown content type | stream straight through (current behaviour, zero added latency) |
| **Buffered JSON** | `application/json` | withhold the body, accumulate to completion, parse, decide, then write a clean (possibly rewritten) body |
| **SSE gate** | `text/event-stream` | parse the SSE event stream; gate each `tool_use` content block at its `content_block_start` (name is known there), forwarding everything else untouched |

A required precondition for both inspecting modes: **stop writing `bodyStart`
immediately**. When the mode is buffered/gated, the first body slice must be routed
into the accumulator/parser, not `res.write()`-en. Keep the current immediate write
only for the passthrough mode.

Responses are already uncompressed: `forwardRequest` sends `Accept-Encoding:
identity` upstream and strips `accept-encoding`, so JSON/SSE bodies are plaintext
and parseable. Keep counting `respBodyBytes` on bytes actually forwarded so token
accounting stays correct.

## 3. Buffered JSON mode (non-streaming) — the simple, fully-correct case

```text
on headers done:
  if mode == BUFFERED_JSON:
    acc = bodyStart            # do NOT res.write(bodyStart)
on data chunk:
    acc += chunk
    if acc.length > maxBodyBytes: failOpenOrClosed(); break
on upstream end:
    uses = parser.extractToolUses(acc)          # reuse the real parser, kill the regex
    blocked = uses.filter(u => mcp.checkToolInvocation(u.toolName, u.args).action == 'block')
    if blocked.empty:
        res.writeHead(originalStatus, headers); res.end(acc)   # forward verbatim
        emit passed events per tool use
    else:
        body' = rewriteResponse(acc, blocked)   # see §5
        res.writeHead(200, jsonHeaders); res.end(body')
        emit blocked events per blocked tool
```

This adds latency equal to the full response time, which is acceptable for
non-streamed tool-call responses (they are small). `extractToolUses` already handles
the response shape (`data.content[]`), so the regex is deleted outright.

## 4. SSE gate mode (streaming) — block at `content_block_start`

Anthropic streams a tool call as:

```
event: content_block_start
data: {"type":"content_block_start","index":1,
       "content_block":{"type":"tool_use","id":"toolu_…","name":"execute_command","input":{}}}
event: content_block_delta              # input_json_delta partials …
event: content_block_stop
```

The **tool name is present in `content_block_start`**, before any argument bytes.
So for the current name-based policy we can decide immediately and never forward the
block. Implementation is an incremental SSE parser that operates per event:

```text
buffer raw text by SSE event boundary ("\n\n")
for each complete event:
    if event is content_block_start AND content_block.type == 'tool_use':
        name = content_block.name
        if mcp.checkToolInvocation(name, {}).action == 'block':
            startSuppressing(index)        # drop this + its deltas + its stop
            emit blocked event
            continue                       # do NOT forward
        else:
            emit passed event (once)
    if suppressing(index of this event):
        if event is content_block_stop: stopSuppressing(index)
        continue                            # swallow the whole tool block
    res.write(event)                        # forward text blocks / message events untouched
```

Key properties:
- Text deltas (`type:"text"`) pass through with **zero added latency** — only
  `tool_use` blocks are buffered/dropped.
- Memory is bounded by a single content block, never the whole stream.
- After suppressing a tool block, emit a synthetic `message_delta` with
  `stop_reason:"end_turn"` + `message_stop` (see §5) so the agent's SSE parser
  terminates cleanly instead of hanging.
- **Argument-based policy** (the future "block `read_file` if path contains
  `/etc/`") requires buffering `content_block_delta` until `content_block_stop`,
  reassembling `partial_json`, then deciding. The gate structure above already
  supports this — switch from decide-at-start to decide-at-stop for tools that
  carry argument rules. Name-based blocking stays decide-at-start.

## 5. Enforcement: rewrite, don't destroy

`res.destroy()` surfaces to the agent as a network error and loses the audit turn.
Prefer producing a **valid, tool-free assistant turn** the agent's SDK accepts:

- **Buffered JSON**: return a well-formed response object with the offending
  `tool_use` block(s) removed and replaced by a `text` block
  (`"[blocked by llm-fw policy: tool 'X']"`), and `stop_reason:"end_turn"`. The
  agent sees a normal assistant message, executes nothing.
- **SSE**: suppress the tool block's events and emit `message_delta`
  (`stop_reason:"end_turn"`) + `message_stop`. Optionally inject a short text block
  first for visibility.

`res.destroy()` remains only as a last-resort fallback if a malformed stream can't
be safely rewritten.

## 6. Provider coverage & config

- `extractToolUses` is implemented for Anthropic (`data.content[]`) and Gemini
  (`candidates[].content.parts[].functionCall`). The buffered-JSON path works for
  both today. SSE gating is Anthropic-shaped first; Gemini SSE is a follow-up.
- Add `mcp.responseInspection: 'off' | 'audit' | 'enforce'` (default `audit`) so
  operators can roll out detection before enabling enforcement, mirroring the
  existing `auditOnly` semantics on the request side.
- On oversized buffered responses (`> maxBodyBytes`): default **fail-open** (forward
  + emit a `warned` event noting inspection was skipped) so a large legit response
  is never silently dropped; make it configurable to fail-closed for high-security
  deployments. Never truncate silently.

## 7. Suggested implementation order

1. Replace the regex block in `forwardRequest` with the **buffered-JSON** path using
   `parser.extractToolUses()`. This alone makes non-streaming enforcement correct and
   deletes the dead regex + `extractToolUses` dead-code smell.
2. Add the **SSE gate** for `text/event-stream` with name-based decide-at-start.
3. Add `responseInspection` config + rewrite-based enforcement (§5).
4. Defer argument-based invocation policy (decide-at-stop) and Gemini SSE.

Unit-testable seams: extract the SSE gate and the JSON rewrite into pure functions
(`gateSseEvent(event, state) -> {forward, emit}`, `rewriteJsonResponse(body, blocked)`)
so they can be tested without a live socket, the way `McpScanner` now is.
