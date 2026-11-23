import { McpScanner } from './scanner.js'
import type { McpCheckResult } from './scanner.js'
import { PayloadParser } from '../../types.js'
import { CohereParser, GeminiParser, OpenAIParser, responsesToolCall } from '../parsers.js'

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

/**
 * Anthropic content blocks that invoke a tool: the client's own (tool_use),
 * Anthropic's server tools (server_tool_use: web search, web fetch, code
 * execution) and the MCP connector's (mcp_tool_use).
 */
const ANTHROPIC_TOOL_BLOCKS = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use'])

/** A Cohere tool call's name, v1 ({name}) or v2 ({function:{name}}). */
function cohereToolName(call: unknown): string {
  const c = call as Record<string, unknown> | null
  if (!c || typeof c !== 'object') return ''
  if (typeof c.name === 'string') return c.name
  const fn = c.function as Record<string, unknown> | undefined
  return typeof fn?.name === 'string' ? fn.name : ''
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

  // Google's Cloud Code API (Antigravity, Gemini CLI) wraps the Gemini
  // response in `response` (#594): rewrite the response and keep the envelope.
  const wrapped = data?.response as Record<string, unknown> | undefined
  if (wrapped && typeof wrapped === 'object' && Array.isArray(wrapped.candidates)) {
    data.response = JSON.parse(rewriteBlockedJsonResponse(JSON.stringify(wrapped), blockedNames)) as unknown
    return JSON.stringify(data)
  }

  // Anthropic shape: top-level content[] holding tool_use blocks, and the
  // server-side (server_tool_use) and MCP connector (mcp_tool_use) calls,
  // whose result blocks name them by tool_use_id and go with them (#851).
  if (Array.isArray(data.content)) {
    const blocks = data.content as Array<Record<string, unknown>>
    const removedIds = new Set<unknown>()
    for (const b of blocks) {
      if (b && ANTHROPIC_TOOL_BLOCKS.has(b.type as string) && blockedNames.has(b.name as string)) removedIds.add(b.id)
    }
    const kept = blocks.filter(b => !(b && ANTHROPIC_TOOL_BLOCKS.has(b.type as string) && blockedNames.has(b.name as string))
      && !(b && b.tool_use_id !== undefined && removedIds.has(b.tool_use_id)))
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

  // Bedrock Converse shape: output.message.content[] holding toolUse blocks
  // (#851). Its `output` is an object, so the Responses branch never saw it.
  const converse = (data.output as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
  if (converse && Array.isArray(converse.content)) {
    const blocks = converse.content as Array<Record<string, unknown>>
    const kept = blocks.filter(b => {
      const tu = b?.toolUse as Record<string, unknown> | undefined
      return !(tu && blockedNames.has(tu.name as string))
    })
    if (kept.length !== blocks.length) {
      kept.push({ text: note })
      converse.content = kept
      if (!kept.some(b => b?.toolUse)) data.stopReason = 'end_turn'
    }
    return JSON.stringify(data)
  }

  // Cohere: v2 puts tool calls in message.tool_calls[] ({function:{name}}),
  // v1 in a top-level tool_calls[] ({name, parameters}) (#851).
  const cohereV2 = data.message as Record<string, unknown> | undefined
  if (cohereV2 && typeof cohereV2 === 'object' && Array.isArray(cohereV2.tool_calls)) {
    const kept = (cohereV2.tool_calls as unknown[]).filter(c => !blockedNames.has(cohereToolName(c)))
    if (kept.length !== cohereV2.tool_calls.length) {
      if (kept.length > 0) {
        cohereV2.tool_calls = kept
      } else {
        delete cohereV2.tool_calls
        const content = Array.isArray(cohereV2.content) ? cohereV2.content as unknown[] : []
        cohereV2.content = [...content, { type: 'text', text: note }]
        if (data.finish_reason === 'TOOL_CALL') data.finish_reason = 'COMPLETE'
      }
    }
    return JSON.stringify(data)
  }
  if (Array.isArray(data.tool_calls)) {
    const kept = (data.tool_calls as unknown[]).filter(c => !blockedNames.has(cohereToolName(c)))
    if (kept.length !== data.tool_calls.length) {
      if (kept.length > 0) data.tool_calls = kept
      else delete data.tool_calls
      data.text = typeof data.text === 'string' && data.text ? `${data.text}\n${note}` : note
    }
    return JSON.stringify(data)
  }

  // OpenAI Responses shape: output[] holding tool-call items.
  if (Array.isArray(data.output)) {
    const items = data.output as unknown[]
    const kept = items.filter(item => {
      const call = responsesToolCall(item)
      return !(call && blockedNames.has(call.toolName))
    })
    if (kept.length !== items.length) {
      kept.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: note, annotations: [] }] })
      data.output = kept
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

interface EventResult { forward: string; decisions: ToolDecision[] }
const NOTHING: EventResult = { forward: '', decisions: [] }

/**
 * The most one SSE event may hold before the gate stops waiting for its end.
 * Generous: a Gemini chunk carries a whole call's arguments, a file included.
 */
export const MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024

/**
 * The blank line that ends an SSE event. A line ends in CRLF, LF or CR
 * (WHATWG), and Google, Azure and proxies in front of providers send CRLF;
 * split on LF only, such a stream was one endless event, held whole and
 * forwarded unread at its end (#851). A CR right before an LF is half of a
 * CRLF, never a line end of its own.
 */
const EVENT_END = /(?:\r\n|\n|\r(?!\n))(?:\r\n|\n|\r)/g

/** The lines of an event, split on any of the three line ends. */
function eventLines(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/)
}

/** The line end an event used, so a rewritten event keeps its stream's framing. */
function eventEnd(raw: string): string {
  return raw.includes('\r\n') ? '\r\n\r\n' : '\n\n'
}

/**
 * Splits the stream into events and hands each to `handleEvent`. An event
 * that grows past MAX_SSE_EVENT_BYTES without ending is dropped unread and
 * reported as a block: it can neither be held without bound nor passed on
 * unchecked. The rest of it, up to its end, is dropped too.
 */
abstract class BufferedSseGate implements SseGate {
  // The pieces of the event still waiting for its end, and the last three
  // characters of them, where a separator split across chunks may start.
  // Appending each chunk to one string and searching it copied the event on
  // every chunk: a 12 MB event in 4 KB chunks held the thread for 4.1 s (#881).
  private pending: string[] = []
  private pendingBytes = 0
  private tail = ''
  private discarding = false
  protected readonly suppressedIndexes = new Set<number>()
  protected readonly emittedTools = new Set<string>()
  protected blockedAny = false

  protected abstract handleEvent(raw: string): EventResult

  /** Decide whatever is still held when the stream ends; nothing by default. */
  protected releaseHeld(): string { return '' }

  /**
   * Release held blocks until none is held: releasing one replays what
   * arrived after it, which can start holding the next.
   */
  protected drain(holding: () => boolean, release: () => EventResult): string {
    let out = ''
    while (holding()) out += release().forward
    return out
  }

  push(text: string): SsePushResult {
    // Searched: the new chunk, after the last characters of what is pending.
    const lb = this.tail
    const hay = lb + text
    const forwardParts: string[] = []
    const decisions: ToolDecision[] = []
    let consumed = 0
    for (;;) {
      EVENT_END.lastIndex = consumed
      const m = EVENT_END.exec(hay)
      // A trailing CR may be the first half of a CRLF still to come.
      if (!m || (m.index + m[0].length === hay.length && m[0].endsWith('\r'))) break
      const end = m.index + m[0].length
      // The first event of this chunk begins in what was pending, which
      // already holds the look-back characters.
      const raw = consumed === 0 ? this.pending.join('') + hay.slice(lb.length, end) : hay.slice(consumed, end)
      consumed = end
      this.pending = []
      this.pendingBytes = 0
      if (this.discarding) { this.discarding = false; continue }
      const r = this.handleEvent(raw)
      if (r.forward) forwardParts.push(r.forward)
      decisions.push(...r.decisions)
    }
    const rest = consumed === 0 ? text : hay.slice(consumed)
    if (rest) {
      this.pending.push(rest)
      this.pendingBytes += rest.length
    }
    this.tail = (consumed === 0 ? lb + rest : rest).slice(-3)
    if (this.pendingBytes > MAX_SSE_EVENT_BYTES) {
      this.pending = []
      this.pendingBytes = 0
      this.tail = ''
      if (!this.discarding) {
        this.blockedAny = true
        decisions.push({ toolName: '(unframed SSE event)', action: 'block', reason: `an SSE event over ${MAX_SSE_EVENT_BYTES} bytes without an end was dropped unread` })
      }
      this.discarding = true
    }
    return { forward: forwardParts.join(''), decisions }
  }

  /**
   * At end of stream the text after the last blank line is gated like any
   * event (a client discards an unterminated event anyway), then a block
   * still held is decided on what arrived, so a cut stream cannot release a
   * call nobody checked.
   */
  flush(): string {
    const rest = this.discarding ? '' : this.pending.join('')
    this.pending = []
    this.pendingBytes = 0
    this.tail = ''
    this.discarding = false
    const tail = rest ? this.handleEvent(rest).forward : ''
    return tail + this.releaseHeld()
  }

  /** A pass decision is reported once per tool name per response. */
  protected passDecision(name: string, result: McpCheckResult): ToolDecision | null {
    if (this.emittedTools.has(name)) return null
    this.emittedTools.add(name)
    return { toolName: name, action: 'pass', audit: result.audit, reason: result.reason }
  }

  /**
   * Once a held block is decided, walk what was held in stream order: its own
   * events go out when it passed, and every other event goes through the gate
   * again, so a block that started inside the held one is checked too.
   */
  protected replay(events: HeldEvent[], heldIndex: number, passed: boolean, out: string[], decisions: ToolDecision[]): void {
    for (const e of events) {
      if (e.index === heldIndex) {
        if (passed) out.push(e.raw)
        continue
      }
      const r = this.handleEvent(e.raw)
      if (r.forward) out.push(r.forward)
      decisions.push(...r.decisions)
    }
  }
}

/** Parse streamed tool arguments; unparseable text is scanned as one string. */
function assembledArgs(json: string, initial: unknown): unknown {
  if (json === '') return initial
  try { return JSON.parse(json) as unknown } catch { return json }
}

interface HeldEvent { raw: string; index: number | undefined }

/**
 * Incremental gate for an Anthropic SSE (`text/event-stream`) response.
 *
 * Feed it raw response text as it streams. It forwards every event verbatim
 * except tool blocks (tool_use, server_tool_use, mcp_tool_use) that are
 * blocked: those events (start, deltas, stop), and the result block of a
 * blocked server or MCP call, are swallowed, and the terminating
 * `message_delta` has its `stop_reason` downgraded from `tool_use` to
 * `end_turn` so the agent's parser terminates cleanly.
 *
 * A tool blocked by name is decided at `content_block_start`, before any
 * argument bytes are forwarded. An execution tool (`bash`, `shell`, ...) is
 * decided by its command, which arrives in later `input_json_delta` frames:
 * its start event carries `input: {}`, so deciding there scanned an empty
 * command and passed every call (#529). Such a block, and every event after
 * its start, is held until its `content_block_stop`, then checked on the
 * assembled input and either dropped or released. The events of other
 * blocks held meanwhile then go through the gate in order; released raw, a
 * second tool block that started inside the held one went out unchecked
 * (#851).
 */
export class SseToolGate extends BufferedSseGate {
  // The execution-tool block being held until its arguments are complete.
  private held: { index: number; name: string; input: unknown; json: string; events: HeldEvent[] } | null = null
  private readonly blockedToolIds = new Set<string>()

  constructor(private readonly mcp: McpScanner) {
    super()
  }

  protected override releaseHeld(): string {
    return this.drain(() => this.held !== null, () => this.release())
  }

  protected handleEvent(raw: string): EventResult {
    const data = parseSseData(raw)
    const type = data && typeof data.type === 'string' ? data.type : undefined
    const index = data && typeof data.index === 'number' ? data.index : undefined

    if (this.held) {
      this.held.events.push({ raw, index })
      if (index !== this.held.index) return NOTHING
      const delta = data?.delta as Record<string, unknown> | undefined
      if (type === 'content_block_delta' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        this.held.json += delta.partial_json
      }
      return type === 'content_block_stop' ? this.release() : NOTHING
    }

    if (!data) return { forward: raw, decisions: [] }

    // A tool block starts: the name is known here, before its arguments.
    const block = data.content_block as Record<string, unknown> | undefined
    if (type === 'content_block_start' && block && ANTHROPIC_TOOL_BLOCKS.has(block.type as string)) {
      const name = typeof block.name === 'string' ? block.name : ''
      const result = this.mcp.checkToolInvocation(name, block.input)
      if (result.action === 'block') {
        if (index !== undefined) this.suppressedIndexes.add(index)
        if (typeof block.id === 'string') this.blockedToolIds.add(block.id)
        this.blockedAny = true
        return { forward: '', decisions: [{ toolName: name, action: 'block', reason: result.reason }] }
      }
      if (index !== undefined && this.mcp.scansArguments(name)) {
        this.held = { index, name, input: block.input, json: '', events: [{ raw, index }] }
        return NOTHING
      }
      const decision = this.passDecision(name, result)
      return { forward: raw, decisions: decision ? [decision] : [] }
    }

    // The result block of a blocked server-side or MCP connector call.
    if (type === 'content_block_start' && block && index !== undefined
      && typeof block.tool_use_id === 'string' && this.blockedToolIds.has(block.tool_use_id)) {
      this.suppressedIndexes.add(index)
      return NOTHING
    }

    // Swallow the deltas/stop of a suppressed tool block.
    if (index !== undefined && this.suppressedIndexes.has(index)) {
      if (type === 'content_block_stop') this.suppressedIndexes.delete(index)
      return NOTHING
    }

    // Downgrade the final stop_reason so the agent doesn't wait on a tool result.
    if (type === 'message_delta' && this.blockedAny) {
      const delta = data.delta as Record<string, unknown> | undefined
      if (delta && delta.stop_reason === 'tool_use') {
        delta.stop_reason = 'end_turn'
        return { forward: `event: message_delta\ndata: ${JSON.stringify(data)}${eventEnd(raw)}`, decisions: [] }
      }
    }

    return { forward: raw, decisions: [] }
  }

  /** Decide the held block on its assembled input, drop or release it, then gate what arrived meanwhile. */
  private release(): EventResult {
    const held = this.held!
    this.held = null
    const result = this.mcp.checkToolInvocation(held.name, assembledArgs(held.json, held.input))
    const decisions: ToolDecision[] = []
    const out: string[] = []
    if (result.action === 'block') {
      this.blockedAny = true
      decisions.push({ toolName: held.name, action: 'block', reason: result.reason })
    } else {
      const decision = this.passDecision(held.name, result)
      if (decision) decisions.push(decision)
    }
    this.replay(held.events, held.index, result.action !== 'block', out, decisions)
    return { forward: out.join(''), decisions }
  }
}

function parseSseData(raw: string): Record<string, unknown> | null {
  const payload = sseDataPayload(raw)
  if (payload === null) return null
  try {
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The joined `data:` lines of an event, or null when it has none. */
function sseDataPayload(raw: string): string | null {
  const dataLines: string[] = []
  for (const line of eventLines(raw)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  return dataLines.length === 0 ? null : dataLines.join('\n')
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
 * held call is checked on its assembled arguments, parsed as JSON (scanned
 * as raw JSON text, a command ending in `"}` met no rule's end, #851), and
 * the held chunks are released without the fragments of any call that blocked.
 */
export class OpenAiSseToolGate extends BufferedSseGate {
  // Held chunks, parsed (or raw when they were not rewritten), and the
  // arguments assembled so far for each held execution-tool call, by index.
  private held: Array<Record<string, unknown> | string> = []
  private readonly heldCalls = new Map<number, { name: string; args: string }>()

  constructor(private readonly mcp: McpScanner) {
    super()
  }

  protected override releaseHeld(): string {
    return this.heldCalls.size > 0 ? this.release().forward : ''
  }

  protected handleEvent(raw: string): EventResult {
    const holding = this.heldCalls.size > 0
    const payload = sseDataPayload(raw)
    let data: Record<string, unknown> | null = null
    if (payload !== null && payload !== '[DONE]') {
      try { data = JSON.parse(payload) as Record<string, unknown> } catch { /* forwarded as it came */ }
    }
    const choices = data && Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : null
    if (!data || !choices) {
      if (!holding) return { forward: raw, decisions: [] }
      // OpenAI terminates the stream with the literal `data: [DONE]` sentinel.
      this.held.push(raw)
      return payload === '[DONE]' ? this.release() : NOTHING
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
            const result = this.mcp.checkToolInvocation(name, assembledArgs(args, fn?.arguments))
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
  private release(): EventResult {
    const decisions: ToolDecision[] = []
    const blocked = new Set<number>()
    for (const [idx, call] of this.heldCalls) {
      const result = this.mcp.checkToolInvocation(call.name, assembledArgs(call.args, ''))
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
 * Incremental gate for an OpenAI Responses API stream (`/v1/responses`, and
 * ChatGPT's `/backend-api/codex/responses` that Codex CLI uses).
 *
 * A tool call is an output item: `response.output_item.added` opens it,
 * argument deltas follow (`function_call_arguments.delta`,
 * `custom_tool_call_input.delta`), and `response.output_item.done` closes it
 * with the complete item. Codex's code mode sends its shell command inside
 * the JavaScript input of one custom tool, `exec`, so a call whose verdict
 * depends on its arguments is held from its start, with every event after
 * it, until its `done`, then checked and dropped or released; the events of
 * other items held meanwhile then go through the gate in order (#851). A
 * blocked call is also removed from the output `response.completed` repeats.
 */
export class ResponsesSseToolGate extends BufferedSseGate {
  private held: { index: number; name: string; args: string; events: HeldEvent[] } | null = null
  private readonly blockedItemIds = new Set<string>()

  constructor(private readonly mcp: McpScanner) {
    super()
  }

  protected override releaseHeld(): string {
    let out = ''
    while (this.held) out += this.release(null).forward
    return out
  }

  protected handleEvent(raw: string): EventResult {
    const data = parseSseData(raw)
    const type = data && typeof data.type === 'string' ? data.type : undefined
    const index = data && typeof data.output_index === 'number' ? data.output_index : undefined

    if (this.held) {
      this.held.events.push({ raw, index })
      if (index !== this.held.index) return NOTHING
      if (typeof data?.delta === 'string' && (type === 'response.function_call_arguments.delta' || type === 'response.custom_tool_call_input.delta')) {
        this.held.args += data.delta
      }
      return type === 'response.output_item.done' ? this.release(data?.item ?? null) : NOTHING
    }

    if (!data) return { forward: raw, decisions: [] }

    if (type === 'response.output_item.added') {
      const call = responsesToolCall(data.item)
      if (call) {
        const result = this.mcp.checkToolInvocation(call.toolName, call.args)
        if (result.action === 'block') return this.block(index, data.item, call.toolName, result.reason)
        if (index !== undefined && this.mcp.scansArguments(call.toolName)) {
          this.held = { index, name: call.toolName, args: '', events: [{ raw, index }] }
          return NOTHING
        }
        const decision = this.passDecision(call.toolName, result)
        return { forward: raw, decisions: decision ? [decision] : [] }
      }
    }

    // Swallow the rest of a suppressed call's events.
    if (index !== undefined && this.suppressedIndexes.has(index)) {
      if (type === 'response.output_item.done') this.suppressedIndexes.delete(index)
      return NOTHING
    }

    // The final event repeats the whole output: drop the blocked calls there too.
    const response = data.response as Record<string, unknown> | undefined
    if (this.blockedItemIds.size > 0 && response && Array.isArray(response.output)) {
      response.output = (response.output as Array<Record<string, unknown>>).filter(o => !(o && this.blockedItemIds.has(o.id as string)))
      return { forward: `event: ${type}\ndata: ${JSON.stringify(data)}${eventEnd(raw)}`, decisions: [] }
    }

    return { forward: raw, decisions: [] }
  }

  private block(index: number | undefined, item: unknown, name: string, reason: string | undefined): EventResult {
    if (index !== undefined) this.suppressedIndexes.add(index)
    const id = (item as Record<string, unknown> | null)?.id
    if (typeof id === 'string') this.blockedItemIds.add(id)
    this.blockedAny = true
    return { forward: '', decisions: [{ toolName: name, action: 'block', reason }] }
  }

  /** Decide the held call on its complete item (or the arguments that arrived), drop or release it, then gate what arrived meanwhile. */
  private release(doneItem: unknown): EventResult {
    const held = this.held!
    this.held = null
    const call = responsesToolCall(doneItem)
    const args: unknown = call ? call.args : held.args
    const result = this.mcp.checkToolInvocation(held.name, args)
    const out: string[] = []
    const decisions: ToolDecision[] = []
    if (result.action === 'block') {
      const opened = parseSseData(held.events[0]!.raw)?.item
      decisions.push(...this.block(undefined, doneItem ?? opened, held.name, result.reason).decisions)
    } else {
      const decision = this.passDecision(held.name, result)
      if (decision) decisions.push(decision)
    }
    this.replay(held.events, held.index, result.action !== 'block', out, decisions)
    return { forward: out.join(''), decisions }
  }
}

/**
 * Incremental gate for a Gemini `streamGenerateContent` stream, bare or in
 * Google Cloud Code's `{ response, traceId }` envelope (Gemini CLI,
 * Antigravity). Each event is a whole `GenerateContentResponse` whose
 * `functionCall` parts carry their complete arguments, so a call is decided
 * in the event that holds it and a blocked one is replaced by a text part.
 * Routed to the Anthropic gate, these streams matched nothing it knows and
 * every call went through (#851).
 */
export class GeminiSseToolGate extends BufferedSseGate {
  constructor(private readonly mcp: McpScanner) {
    super()
  }

  protected handleEvent(raw: string): EventResult {
    const data = parseSseData(raw)
    if (!data) return { forward: raw, decisions: [] }
    const wrapped = data.response as Record<string, unknown> | undefined
    const body = wrapped && typeof wrapped === 'object' && Array.isArray(wrapped.candidates) ? wrapped : data
    if (!Array.isArray(body.candidates)) return { forward: raw, decisions: [] }
    const decisions: ToolDecision[] = []
    const blocked: string[] = []
    for (const cand of body.candidates as Array<Record<string, unknown>>) {
      const content = cand?.content as Record<string, unknown> | undefined
      if (!content || !Array.isArray(content.parts)) continue
      const parts = content.parts as Array<Record<string, unknown>>
      const kept = parts.filter(p => {
        const fc = p?.functionCall as Record<string, unknown> | undefined
        if (!fc) return true
        const name = typeof fc.name === 'string' ? fc.name : ''
        const result = this.mcp.checkToolInvocation(name, fc.args)
        if (result.action === 'block') {
          blocked.push(name)
          decisions.push({ toolName: name, action: 'block', reason: result.reason })
          return false
        }
        const decision = this.passDecision(name, result)
        if (decision) decisions.push(decision)
        return true
      })
      if (kept.length !== parts.length) {
        kept.push({ text: `[llm-fw blocked tool call(s): ${blocked.join(', ')}]` })
        content.parts = kept
      }
    }
    if (blocked.length === 0) return { forward: raw, decisions }
    this.blockedAny = true
    return { forward: `data: ${JSON.stringify(data)}${eventEnd(raw)}`, decisions }
  }
}

/**
 * Select the SSE gate matching the provider that produced the response, so the
 * stream is parsed in its native event format. OpenAI-compatible providers get
 * the OpenAI gate, or the Responses gate on a Responses API path; Gemini and
 * Cloud Code get the Gemini gate; everything else (Anthropic natively, and
 * Bedrock's Anthropic-shaped InvokeModel stream) uses the Anthropic-shaped gate.
 */
/** A Cohere v2 stream event's tool call: `delta.message.tool_calls`, one object (or a one-element list). */
function cohereStreamCall(data: Record<string, unknown>): { name: string; args: string } {
  const delta = data.delta as Record<string, unknown> | undefined
  const message = delta?.message as Record<string, unknown> | undefined
  let call: unknown = message?.tool_calls
  if (Array.isArray(call)) call = call[0]
  const fn = (call as Record<string, unknown> | undefined)?.function as Record<string, unknown> | undefined
  return {
    name: typeof fn?.name === 'string' ? fn.name : '',
    args: typeof fn?.arguments === 'string' ? fn.arguments : '',
  }
}

/** `raw` with its `data:` payload replaced by `data`, its other lines and framing kept. */
function withData(raw: string, data: Record<string, unknown>): string {
  let end = raw.length
  while (end > 0 && (raw[end - 1] === '\n' || raw[end - 1] === '\r')) end--
  const lines = eventLines(raw.slice(0, end)).filter(l => !l.startsWith('data:'))
  const nl = raw.includes('\r\n') ? '\r\n' : '\n'
  return [...lines, `data: ${JSON.stringify(data)}`].join(nl) + eventEnd(raw)
}

/**
 * Incremental gate for a Cohere v2 (`/v2/chat`) stream (#881). A call is
 * `tool-call-start` (its name in `delta.message.tool_calls.function`), then
 * `tool-call-delta` argument fragments, then `tool-call-end`, all carrying
 * the call's `index`. A call blocked by name is dropped from its start; an
 * execution tool is held with every event after its start until its end, then
 * decided on the assembled arguments, as the Anthropic gate does. Once a call
 * was blocked, `message-end`'s `finish_reason` `TOOL_CALL` becomes
 * `COMPLETE`, so the client does not wait for a result.
 */
export class CohereSseToolGate extends BufferedSseGate {
  private held: { index: number; name: string; args: string; events: HeldEvent[] } | null = null

  constructor(private readonly mcp: McpScanner) {
    super()
  }

  protected override releaseHeld(): string {
    return this.drain(() => this.held !== null, () => this.release())
  }

  protected handleEvent(raw: string): EventResult {
    const data = parseSseData(raw)
    const type = data && typeof data.type === 'string' ? data.type : undefined
    const index = data && typeof data.index === 'number' ? data.index : undefined

    if (this.held) {
      this.held.events.push({ raw, index })
      if (index !== this.held.index) return NOTHING
      if (type === 'tool-call-delta' && data) this.held.args += cohereStreamCall(data).args
      return type === 'tool-call-end' ? this.release() : NOTHING
    }

    if (!data) return { forward: raw, decisions: [] }

    if (type === 'tool-call-start') {
      const { name, args } = cohereStreamCall(data)
      const result = this.mcp.checkToolInvocation(name, assembledArgs(args, {}))
      if (result.action === 'block') {
        if (index !== undefined) this.suppressedIndexes.add(index)
        this.blockedAny = true
        return { forward: '', decisions: [{ toolName: name, action: 'block', reason: result.reason }] }
      }
      if (index !== undefined && this.mcp.scansArguments(name)) {
        this.held = { index, name, args, events: [{ raw, index }] }
        return NOTHING
      }
      const decision = this.passDecision(name, result)
      return { forward: raw, decisions: decision ? [decision] : [] }
    }

    if (index !== undefined && this.suppressedIndexes.has(index) && type?.startsWith('tool-call-')) {
      if (type === 'tool-call-end') this.suppressedIndexes.delete(index)
      return NOTHING
    }

    if (type === 'message-end' && this.blockedAny) {
      const delta = data.delta as Record<string, unknown> | undefined
      if (delta && delta.finish_reason === 'TOOL_CALL') {
        delta.finish_reason = 'COMPLETE'
        return { forward: withData(raw, data), decisions: [] }
      }
    }

    return { forward: raw, decisions: [] }
  }

  private release(): EventResult {
    const held = this.held!
    this.held = null
    const result = this.mcp.checkToolInvocation(held.name, assembledArgs(held.args, {}))
    const decisions: ToolDecision[] = []
    const out: string[] = []
    if (result.action === 'block') {
      this.blockedAny = true
      decisions.push({ toolName: held.name, action: 'block', reason: result.reason })
    } else {
      const decision = this.passDecision(held.name, result)
      if (decision) decisions.push(decision)
    }
    this.replay(held.events, held.index, result.action !== 'block', out, decisions)
    return { forward: out.join(''), decisions }
  }
}

/**
 * Incremental gate for a Cohere v1 (`/v1/chat`) stream, newline-delimited
 * JSON rather than SSE (#881). Calls stream as `tool-calls-chunk` events
 * (`tool_call_delta`: an index, the name, then parameter text), then a
 * `tool-calls-generation` event carries them whole, and `stream-end`
 * repeats them in `response.tool_calls`. From the first chunk on, lines are
 * held until the generation event; each call is decided on its complete
 * parameters, and a blocked one is removed from its chunks, the generation
 * event and the final response. A stream that ends first is decided on the
 * chunks. A line over MAX_SSE_EVENT_BYTES without an end is dropped and
 * reported, like an unframed SSE event.
 */
export class CohereNdjsonToolGate implements SseGate {
  // The pieces of a line still waiting for its end. Appending to one string
  // and searching it copied the whole line on every chunk, quadratic in it.
  private pending: string[] = []
  private pendingBytes = 0
  private discarding = false
  private held: string[] | null = null
  private readonly chunkCalls = new Map<number, { name: string; params: string }>()
  private readonly blockedNames = new Set<string>()
  private readonly emitted = new Set<string>()

  constructor(private readonly mcp: McpScanner) {}

  push(text: string): SsePushResult {
    const out: string[] = []
    const decisions: ToolDecision[] = []
    let start = 0
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      const piece = text.slice(start, nl + 1)
      start = nl + 1
      const line = this.pending.length ? this.pending.join('') + piece : piece
      this.pending = []
      this.pendingBytes = 0
      if (this.discarding) { this.discarding = false; continue }
      this.handleLine(line, out, decisions)
    }
    if (start < text.length && !this.discarding) {
      this.pending.push(text.slice(start))
      this.pendingBytes += text.length - start
    }
    if (this.pendingBytes > MAX_SSE_EVENT_BYTES) {
      this.pending = []
      this.pendingBytes = 0
      if (!this.discarding) decisions.push({ toolName: '(unframed stream line)', action: 'block', reason: `a stream line over ${MAX_SSE_EVENT_BYTES} bytes without an end was dropped unread` })
      this.discarding = true
    }
    return { forward: out.join(''), decisions }
  }

  flush(): string {
    const rest = this.discarding ? '' : this.pending.join('')
    this.pending = []
    this.pendingBytes = 0
    this.discarding = false
    const out: string[] = []
    if (rest) this.handleLine(rest, out, [])
    if (this.held) this.decideHeld(null, out, [])
    return out.join('')
  }

  private handleLine(line: string, out: string[], decisions: ToolDecision[]): void {
    let data: Record<string, unknown> | null = null
    try { data = JSON.parse(line) as Record<string, unknown> } catch { /* not JSON: forwarded or held as it is */ }
    const type = data && typeof data.event_type === 'string' ? data.event_type : undefined
    if (type === 'tool-calls-chunk' && data) {
      const d = data.tool_call_delta as Record<string, unknown> | undefined
      const idx = typeof d?.index === 'number' ? d.index : 0
      const call = this.chunkCalls.get(idx) ?? { name: '', params: '' }
      if (typeof d?.name === 'string') call.name += d.name
      if (typeof d?.parameters === 'string') call.params += d.parameters
      this.chunkCalls.set(idx, call)
      this.held ??= []
      this.held.push(line)
      return
    }
    if (type === 'tool-calls-generation' && data) {
      this.decideHeld({ data, line }, out, decisions)
      return
    }
    if (this.held) { this.held.push(line); return }
    if (type === 'stream-end' && data && this.blockedNames.size > 0) {
      out.push(this.rewriteEnd(data, line))
      return
    }
    out.push(line)
  }

  /** Decide the calls (from the generation event, or the chunks when it never came), then emit what was held. */
  private decideHeld(gen: { data: Record<string, unknown>; line: string } | null, out: string[], decisions: ToolDecision[]): void {
    const generation = gen?.data ?? null
    const calls: { name: string; args: unknown }[] = generation && Array.isArray(generation.tool_calls)
      ? (generation.tool_calls as Array<Record<string, unknown>>).map(c => ({ name: cohereToolName(c), args: c?.parameters ?? {} }))
      : [...this.chunkCalls.values()].map(c => ({ name: c.name, args: assembledArgs(c.params, {}) }))
    const blockedIdx = new Set<number>()
    calls.forEach((call, i) => {
      const result = this.mcp.checkToolInvocation(call.name, call.args)
      if (result.action === 'block') {
        blockedIdx.add(i)
        this.blockedNames.add(call.name)
        decisions.push({ toolName: call.name, action: 'block', reason: result.reason })
      } else if (!this.emitted.has(call.name)) {
        this.emitted.add(call.name)
        decisions.push({ toolName: call.name, action: 'pass', audit: result.audit, reason: result.reason })
      }
    })
    const held = this.held ?? []
    this.held = null
    this.chunkCalls.clear()
    for (const line of held) {
      if (blockedIdx.size === 0) { out.push(line); continue }
      let data: Record<string, unknown> | null = null
      try { data = JSON.parse(line) as Record<string, unknown> } catch { /* kept */ }
      const d = data?.tool_call_delta as Record<string, unknown> | undefined
      const idx = typeof d?.index === 'number' ? d.index : 0
      if (data?.event_type === 'tool-calls-chunk' && blockedIdx.has(idx)) continue
      if (data?.event_type === 'stream-end') { out.push(this.rewriteEnd(data, line)); continue }
      out.push(line)
    }
    if (!gen || !generation) return
    if (blockedIdx.size === 0) { out.push(gen.line); return }
    const kept = (generation.tool_calls as unknown[]).filter((_c, i) => !blockedIdx.has(i))
    if (kept.length === 0) return
    generation.tool_calls = kept
    out.push(serializeLine(generation, gen.line))
  }

  /** The final event without the blocked calls. */
  private rewriteEnd(data: Record<string, unknown>, line: string): string {
    const response = data.response as Record<string, unknown> | undefined
    if (!response || !Array.isArray(response.tool_calls)) return line
    const kept = (response.tool_calls as unknown[]).filter(c => !this.blockedNames.has(cohereToolName(c)))
    if (kept.length === response.tool_calls.length) return line
    if (kept.length > 0) response.tool_calls = kept
    else delete response.tool_calls
    return serializeLine(data, line)
  }
}

/** `data` as one NDJSON line, ending as `like` did. */
function serializeLine(data: Record<string, unknown>, like: string): string {
  return JSON.stringify(data) + (like.endsWith('\r\n') ? '\r\n' : '\n')
}

export function createSseGate(parser: PayloadParser, mcp: McpScanner, path = ''): SseGate {
  if (parser instanceof OpenAIParser) {
    return /\/responses(?:[/?]|$)/.test(path) ? new ResponsesSseToolGate(mcp) : new OpenAiSseToolGate(mcp)
  }
  if (parser instanceof GeminiParser) return new GeminiSseToolGate(mcp)
  // #881: v1 streams newline-delimited JSON, v2 SSE; both went to the Anthropic gate.
  if (parser instanceof CohereParser) {
    return /\/v1\/chat(?:[/?]|$)/.test(path) ? new CohereNdjsonToolGate(mcp) : new CohereSseToolGate(mcp)
  }
  return new SseToolGate(mcp)
}
