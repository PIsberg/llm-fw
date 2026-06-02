import { McpScanner } from './scanner.js'
import { PayloadParser } from '../../types.js'

/**
 * Response-side (inbound) MCP interception.
 *
 * The LLM's response is where `tool_use` invocations actually arrive. To block
 * one we must decide BEFORE the bytes that convey it are forwarded to the agent
 * — see DESIGN-mcp-response.md. This module holds the pure, socket-free logic so
 * it can be unit-tested directly:
 *   - non-streaming JSON: inspect the full body, then rewrite it tool-free.
 *   - streaming SSE: gate each `tool_use` content block at its start event.
 */

export interface ToolDecision {
  toolName: string
  action: 'block' | 'pass'
  reason?: string
}

export interface JsonInspection {
  decisions: ToolDecision[]
  blockedNames: Set<string>
}

/** Inspect a complete (non-streaming) LLM JSON response for tool invocations. */
export function inspectJsonResponse(body: string, parser: PayloadParser, mcp: McpScanner): JsonInspection {
  const decisions: ToolDecision[] = []
  const blockedNames = new Set<string>()
  for (const use of parser.extractToolUses(body)) {
    const result = mcp.checkToolInvocation(use.toolName, use.args)
    decisions.push({ toolName: use.toolName, action: result.action, reason: result.reason })
    if (result.action === 'block') blockedNames.add(use.toolName)
  }
  return { decisions, blockedNames }
}

/**
 * Return a copy of the JSON response body with the blocked tool calls removed,
 * replaced by a short text block, so the agent receives a valid tool-free turn
 * and executes nothing. Returns the body unchanged if it can't be parsed.
 */
export function rewriteBlockedJsonResponse(body: string, blockedNames: Set<string>): string {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(body) as Record<string, unknown>
  } catch {
    return body
  }
  const note = `[llm-fw blocked tool call(s): ${[...blockedNames].join(', ')}]`

  // Anthropic shape: top-level content[] holding tool_use blocks.
  if (Array.isArray(data.content)) {
    const blocks = data.content as Array<Record<string, unknown>>
    const kept = blocks.filter(b => !(b && b.type === 'tool_use' && blockedNames.has(b.name as string)))
    if (kept.length !== blocks.length) {
      kept.push({ type: 'text', text: note })
      data.content = kept
      data.stop_reason = kept.some(b => b && b.type === 'tool_use') ? 'tool_use' : 'end_turn'
    }
    return JSON.stringify(data)
  }

  // OpenAI shape: choices[].message.tool_calls[] holding function calls.
  if (Array.isArray(data.choices)) {
    for (const choice of data.choices as Array<Record<string, unknown>>) {
      const message = choice.message as Record<string, unknown> | undefined
      if (message && Array.isArray(message.tool_calls)) {
        const calls = message.tool_calls as Array<Record<string, unknown>>
        const kept = calls.filter(c => {
          const fn = c.function as Record<string, unknown> | undefined
          return !(fn && blockedNames.has(fn.name as string))
        })
        if (kept.length !== calls.length) {
          message.tool_calls = kept
          if (kept.length === 0) {
            delete message.tool_calls
            message.content = note
            choice.finish_reason = 'stop'
          }
        }
      }
    }
    return JSON.stringify(data)
  }

  // Gemini shape: candidates[].content.parts[] holding functionCall parts.
  if (Array.isArray(data.candidates)) {
    for (const cand of data.candidates as Array<Record<string, unknown>>) {
      const content = cand.content as Record<string, unknown> | undefined
      if (content && Array.isArray(content.parts)) {
        const parts = content.parts as Array<Record<string, unknown>>
        const kept = parts.filter(p => {
          const fc = p.functionCall as Record<string, unknown> | undefined
          return !(fc && blockedNames.has(fc.name as string))
        })
        if (kept.length !== parts.length) kept.push({ text: note })
        content.parts = kept
      }
    }
    return JSON.stringify(data)
  }

  return body
}

export interface SsePushResult {
  /** Text to forward to the agent (suppressed events are dropped). */
  forward: string
  /** Tool decisions made while processing this chunk, for audit emission. */
  decisions: ToolDecision[]
}

/**
 * Incremental gate for an Anthropic SSE (`text/event-stream`) response.
 *
 * Feed it raw response text as it streams. It forwards every event verbatim
 * except `tool_use` content blocks whose name is blocked: those events (start,
 * deltas, stop) are swallowed, and the terminating `message_delta` has its
 * `stop_reason` downgraded from `tool_use` to `end_turn` so the agent's parser
 * terminates cleanly. The tool name is present in `content_block_start`, so the
 * decision is made before any argument bytes are forwarded.
 */
export class SseToolGate {
  private buf = ''
  private readonly suppressedIndexes = new Set<number>()
  private readonly emittedTools = new Set<string>()
  private blockedAny = false

  constructor(private readonly mcp: McpScanner) {}

  push(text: string): SsePushResult {
    this.buf += text
    const forwardParts: string[] = []
    const decisions: ToolDecision[] = []
    let sep = this.buf.indexOf('\n\n')
    while (sep !== -1) {
      const raw = this.buf.slice(0, sep + 2)
      this.buf = this.buf.slice(sep + 2)
      const { forward, decision } = this.handleEvent(raw)
      if (forward) forwardParts.push(forward)
      if (decision) decisions.push(decision)
      sep = this.buf.indexOf('\n\n')
    }
    return { forward: forwardParts.join(''), decisions }
  }

  /** Forward any trailing buffered text once the stream ends. */
  flush(): string {
    const rest = this.buf
    this.buf = ''
    return rest
  }

  private handleEvent(raw: string): { forward: string; decision: ToolDecision | null } {
    const data = parseSseData(raw)
    if (!data) return { forward: raw, decision: null }
    const type = typeof data.type === 'string' ? data.type : undefined
    const index = typeof data.index === 'number' ? data.index : undefined

    // A tool_use block starts: the name is known here, before its arguments.
    const block = data.content_block as Record<string, unknown> | undefined
    if (type === 'content_block_start' && block && block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : ''
      const result = this.mcp.checkToolInvocation(name, block.input)
      if (result.action === 'block') {
        if (index !== undefined) this.suppressedIndexes.add(index)
        this.blockedAny = true
        return { forward: '', decision: { toolName: name, action: 'block', reason: result.reason } }
      }
      const decision = this.emittedTools.has(name) ? null : { toolName: name, action: 'pass' as const }
      this.emittedTools.add(name)
      return { forward: raw, decision }
    }

    // Swallow the deltas/stop of a suppressed tool block.
    if (index !== undefined && this.suppressedIndexes.has(index)) {
      if (type === 'content_block_stop') this.suppressedIndexes.delete(index)
      return { forward: '', decision: null }
    }

    // Downgrade the final stop_reason so the agent doesn't wait on a tool result.
    if (type === 'message_delta' && this.blockedAny) {
      const delta = data.delta as Record<string, unknown> | undefined
      if (delta && delta.stop_reason === 'tool_use') {
        delta.stop_reason = 'end_turn'
        return { forward: `event: message_delta\ndata: ${JSON.stringify(data)}\n\n`, decision: null }
      }
    }

    return { forward: raw, decision: null }
  }
}

function parseSseData(raw: string): Record<string, unknown> | null {
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  try {
    return JSON.parse(dataLines.join('\n')) as Record<string, unknown>
  } catch {
    return null
  }
}
