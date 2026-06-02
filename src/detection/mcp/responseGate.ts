import { McpScanner } from './scanner.js'
import { PayloadParser } from '../../types.js'
import { OpenAIParser } from '../parsers.js'

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
  // Set when a policy matched but `auditOnly` let the call through; callers
  // emit a 'warned' audit event instead of a silent 'passed'.
  audit?: boolean
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
    decisions.push({ toolName: use.toolName, action: result.action, reason: result.reason, audit: result.audit })
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
 * Provider-agnostic streaming gate contract. Feed raw response text via `push`
 * (returns the filtered bytes to forward + any tool decisions); call `flush`
 * once at end-of-stream to drain trailing buffered text.
 */
export interface SseGate {
  push(text: string): SsePushResult
  flush(): string
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
export class SseToolGate implements SseGate {
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
      const decision = this.emittedTools.has(name)
        ? null
        : { toolName: name, action: 'pass' as const, audit: result.audit, reason: result.reason }
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

/**
 * Incremental gate for an OpenAI-compatible SSE (`text/event-stream`) response.
 *
 * OpenAI streams tool calls differently from Anthropic: each `data:` chunk holds
 * `choices[].delta.tool_calls[]`. A call's NAME arrives in the first fragment for
 * a given tool-call index (alongside its id); later fragments for that index
 * carry only `function.arguments` text. So we decide at the name fragment,
 * suppress every later fragment for a blocked index, and downgrade the
 * terminating `finish_reason` from `tool_calls` to `stop` so the agent ends its
 * turn cleanly. `data: [DONE]` and any non-tool chunk are forwarded verbatim.
 */
export class OpenAiSseToolGate implements SseGate {
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
      const r = this.handleEvent(raw)
      if (r.forward) forwardParts.push(r.forward)
      decisions.push(...r.decisions)
      sep = this.buf.indexOf('\n\n')
    }
    return { forward: forwardParts.join(''), decisions }
  }

  flush(): string {
    const rest = this.buf
    this.buf = ''
    return rest
  }

  private handleEvent(raw: string): { forward: string; decisions: ToolDecision[] } {
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) return { forward: raw, decisions: [] }
    const payload = dataLines.join('\n')
    // OpenAI terminates the stream with the literal `data: [DONE]` sentinel.
    if (payload === '[DONE]') return { forward: raw, decisions: [] }

    let data: Record<string, unknown>
    try { data = JSON.parse(payload) as Record<string, unknown> } catch { return { forward: raw, decisions: [] } }

    const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : null
    if (!choices) return { forward: raw, decisions: [] }

    const decisions: ToolDecision[] = []
    let mutated = false

    for (const choice of choices) {
      const delta = choice.delta as Record<string, unknown> | undefined
      const calls = delta && Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : null
      if (delta && calls) {
        const kept: Array<Record<string, unknown>> = []
        for (const call of calls) {
          const idx = typeof call.index === 'number' ? call.index : -1
          const fn = call.function as Record<string, unknown> | undefined
          const name = fn && typeof fn.name === 'string' ? fn.name : ''
          if (name) {
            // First fragment for this tool call — the name is known, so decide now.
            const result = this.mcp.checkToolInvocation(name, fn?.arguments)
            if (result.action === 'block') {
              this.suppressedIndexes.add(idx)
              this.blockedAny = true
              decisions.push({ toolName: name, action: 'block', reason: result.reason })
              mutated = true
              continue
            }
            if (!this.emittedTools.has(name)) decisions.push({ toolName: name, action: 'pass', audit: result.audit, reason: result.reason })
            this.emittedTools.add(name)
            kept.push(call)
          } else if (this.suppressedIndexes.has(idx)) {
            // Argument fragment belonging to a blocked call — drop it.
            mutated = true
          } else {
            kept.push(call)
          }
        }
        if (kept.length !== calls.length) {
          if (kept.length > 0) delta.tool_calls = kept
          else delete delta.tool_calls
          mutated = true
        }
      }

      // Downgrade the terminal stop once any tool was blocked so the agent
      // doesn't sit waiting to execute a tool it will never receive.
      if (this.blockedAny && choice.finish_reason === 'tool_calls') {
        choice.finish_reason = 'stop'
        mutated = true
      }
    }

    if (!mutated) return { forward: raw, decisions }

    // Drop the event if nothing meaningful remains (all deltas empty, no terminal
    // finish_reason); otherwise forward the rewritten chunk.
    const empty = choices.every(c => {
      const d = c.delta as Record<string, unknown> | undefined
      const deltaEmpty = !d || Object.keys(d).length === 0
      const fr = c.finish_reason
      return deltaEmpty && (fr === null || fr === undefined)
    })
    if (empty) return { forward: '', decisions }
    return { forward: `data: ${JSON.stringify(data)}\n\n`, decisions }
  }
}

/**
 * Select the SSE gate matching the provider that produced the response, so the
 * stream is parsed in its native event format. OpenAI-compatible providers get
 * the OpenAI gate; everything else (Anthropic natively, Gemini/Cohere as
 * passthrough) uses the Anthropic-shaped gate.
 */
export function createSseGate(parser: PayloadParser, mcp: McpScanner): SseGate {
  if (parser instanceof OpenAIParser) return new OpenAiSseToolGate(mcp)
  return new SseToolGate(mcp)
}
