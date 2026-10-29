import { McpScanner } from './scanner.js'
import type { McpCheckResult } from './scanner.js'
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
 *   - streaming SSE: gate each `tool_use` content block at its start event,
 *     or, for an execution tool, once its streamed arguments are complete.
 */

export interface ToolDecision {
  toolName: string
  action: 'block' | 'pass'
  reason?: string | undefined
  // Set when a policy matched but `auditOnly` let the call through; callers
  // emit a 'warned' audit event instead of a silent 'passed'.
  audit?: boolean | undefined
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
 * except `tool_use` content blocks that are blocked: those events (start,
 * deltas, stop) are swallowed, and the terminating `message_delta` has its
 * `stop_reason` downgraded from `tool_use` to `end_turn` so the agent's parser
 * terminates cleanly.
 *
 * A tool blocked by name is decided at `content_block_start`, before any
 * argument bytes are forwarded. An execution tool (`bash`, `shell`, ...) is
 * decided by its command, which arrives in later `input_json_delta` frames:
 * its start event carries `input: {}`, so deciding there scanned an empty
 * command and passed every call (#529). Such a block, and every event after
 * its start, is held until its `content_block_stop`, then checked on the
 * assembled input and either dropped or released in order.
 */
abstract class BufferedSseGate implements SseGate {
  protected buf = ''
  protected readonly suppressedIndexes = new Set<number>()
  protected readonly emittedTools = new Set<string>()
  protected blockedAny = false

  abstract push(text: string): SsePushResult

  /** Forward any trailing buffered text once the stream ends. */
  flush(): string {
    const rest = this.buf
    this.buf = ''
    return rest
  }

  /** A pass decision is reported once per tool name per response. */
  protected passDecision(name: string, result: McpCheckResult): ToolDecision | null {
    if (this.emittedTools.has(name)) return null
    this.emittedTools.add(name)
    return { toolName: name, action: 'pass', audit: result.audit, reason: result.reason }
  }
}

/** Parse streamed tool arguments; unparseable text is scanned as one string. */
function assembledArgs(json: string, initial: unknown): unknown {
  if (json === '') return initial
  try { return JSON.parse(json) as unknown } catch { return json }
}

interface HeldEvent { raw: string; index: number | undefined }

export class SseToolGate extends BufferedSseGate {
  // The execution-tool block being held until its arguments are complete.
  private held: { index: number; name: string; input: unknown; json: string; events: HeldEvent[] } | null = null

  constructor(private readonly mcp: McpScanner) {
    super()
  }

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

  /**
   * At end of stream a block still held never completed: decide on what
   * arrived, so a cut stream cannot release a command nobody checked.
   */
  override flush(): string {
    const released = this.held ? this.release().forward : ''
    return released + super.flush()
  }

  private handleEvent(raw: string): { forward: string; decision: ToolDecision | null } {
    const data = parseSseData(raw)
    const type = data && typeof data.type === 'string' ? data.type : undefined
    const index = data && typeof data.index === 'number' ? data.index : undefined

    if (this.held) {
      this.held.events.push({ raw, index })
      if (index !== this.held.index) return { forward: '', decision: null }
      const delta = data?.delta as Record<string, unknown> | undefined
      if (type === 'content_block_delta' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        this.held.json += delta.partial_json
      }
      return type === 'content_block_stop' ? this.release() : { forward: '', decision: null }
    }

    if (!data) return { forward: raw, decision: null }

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
      if (index !== undefined && this.mcp.scansArguments(name)) {
        this.held = { index, name, input: block.input, json: '', events: [{ raw, index }] }
        return { forward: '', decision: null }
      }
      return { forward: raw, decision: this.passDecision(name, result) }
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

  /** Decide the held block on its assembled input, then drop or release it. */
  private release(): { forward: string; decision: ToolDecision | null } {
    const held = this.held!
    this.held = null
    const result = this.mcp.checkToolInvocation(held.name, assembledArgs(held.json, held.input))
    if (result.action === 'block') {
      this.blockedAny = true
      // Events of other blocks that arrived meanwhile (a ping) still go out.
      const others = held.events.filter(e => e.index !== held.index).map(e => e.raw).join('')
      return { forward: others, decision: { toolName: held.name, action: 'block', reason: result.reason } }
    }
    return { forward: held.events.map(e => e.raw).join(''), decision: this.passDecision(held.name, result) }
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
 *
 * An execution tool is decided by its arguments, which the name fragment
 * carries empty (#529). From its name fragment on, every chunk is held until
 * one carries a `finish_reason` (or `[DONE]`, or the stream ends); then each
 * held call is checked on its assembled arguments, and the held chunks are
 * released without the fragments of any call that blocked.
 */
export class OpenAiSseToolGate extends BufferedSseGate {
  // Held chunks, parsed (or raw when they were not rewritten), and the
  // arguments assembled so far for each held execution-tool call, by index.
  private held: Array<Record<string, unknown> | string> = []
  private readonly heldCalls = new Map<number, { name: string; args: string }>()

  constructor(private readonly mcp: McpScanner) {
    super()
  }

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

  /** A call still held when the stream ends is decided on what arrived. */
  override flush(): string {
    const released = this.heldCalls.size > 0 ? this.release().forward : ''
    return released + super.flush()
  }

  private handleEvent(raw: string): { forward: string; decisions: ToolDecision[] } {
    const holding = this.heldCalls.size > 0
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    const payload = dataLines.join('\n')
    let data: Record<string, unknown> | null = null
    if (dataLines.length > 0 && payload !== '[DONE]') {
      try { data = JSON.parse(payload) as Record<string, unknown> } catch { /* forwarded as it came */ }
    }
    const choices = data && Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : null
    if (!data || !choices) {
      if (!holding) return { forward: raw, decisions: [] }
      // OpenAI terminates the stream with the literal `data: [DONE]` sentinel.
      this.held.push(raw)
      return payload === '[DONE]' ? this.release() : { forward: '', decisions: [] }
    }

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
          const args = fn && typeof fn.arguments === 'string' ? fn.arguments : ''
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
            if (this.mcp.scansArguments(name)) {
              this.heldCalls.set(idx, { name, args })
            } else {
              const decision = this.passDecision(name, result)
              if (decision) decisions.push(decision)
            }
            kept.push(call)
          } else if (this.suppressedIndexes.has(idx)) {
            // Argument fragment belonging to a blocked call — drop it.
            mutated = true
          } else {
            const heldCall = this.heldCalls.get(idx)
            if (heldCall) heldCall.args += args
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

    if (this.heldCalls.size > 0) {
      this.held.push(mutated ? data : raw)
      const finished = choices.some(c => c.finish_reason !== null && c.finish_reason !== undefined)
      if (!finished) return { forward: '', decisions }
      const released = this.release()
      return { forward: released.forward, decisions: [...decisions, ...released.decisions] }
    }

    if (!mutated) return { forward: raw, decisions }
    return { forward: serializeChunk(data), decisions }
  }

  /** Decide every held call on its assembled arguments, then release the held chunks. */
  private release(): { forward: string; decisions: ToolDecision[] } {
    const decisions: ToolDecision[] = []
    const blocked = new Set<number>()
    for (const [idx, call] of this.heldCalls) {
      const result = this.mcp.checkToolInvocation(call.name, call.args)
      if (result.action === 'block') {
        blocked.add(idx)
        this.suppressedIndexes.add(idx)
        this.blockedAny = true
        decisions.push({ toolName: call.name, action: 'block', reason: result.reason })
      } else {
        const decision = this.passDecision(call.name, result)
        if (decision) decisions.push(decision)
      }
    }
    this.heldCalls.clear()
    const held = this.held
    this.held = []
    if (blocked.size === 0) {
      return { forward: held.map(e => typeof e === 'string' ? e : serializeChunk(e)).join(''), decisions }
    }
    const parts: string[] = []
    for (const event of held) {
      if (typeof event === 'string') {
        const data = parseSseData(event)
        if (!data || !Array.isArray(data.choices)) { parts.push(event); continue }
        parts.push(serializeChunk(dropCalls(data, blocked)))
        continue
      }
      parts.push(serializeChunk(dropCalls(event, blocked)))
    }
    return { forward: parts.join(''), decisions }
  }
}

/** Remove the blocked calls' fragments from a chunk and end its turn without them. */
function dropCalls(data: Record<string, unknown>, blocked: Set<number>): Record<string, unknown> {
  for (const choice of data.choices as Array<Record<string, unknown>>) {
    const delta = choice.delta as Record<string, unknown> | undefined
    if (delta && Array.isArray(delta.tool_calls)) {
      const kept = (delta.tool_calls as Array<Record<string, unknown>>).filter(c => !blocked.has(typeof c.index === 'number' ? c.index : -1))
      if (kept.length > 0) delta.tool_calls = kept
      else delete delta.tool_calls
    }
    if (choice.finish_reason === 'tool_calls') choice.finish_reason = 'stop'
  }
  return data
}

/**
 * A rewritten chunk, or nothing when no choice has a delta or a terminal
 * finish_reason left in it.
 */
function serializeChunk(data: Record<string, unknown>): string {
  const choices = data.choices as Array<Record<string, unknown>>
  const empty = choices.every(c => {
    const d = c.delta as Record<string, unknown> | undefined
    const deltaEmpty = !d || Object.keys(d).length === 0
    const fr = c.finish_reason
    return deltaEmpty && (fr === null || fr === undefined)
  })
  return empty ? '' : `data: ${JSON.stringify(data)}\n\n`
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
