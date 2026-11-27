import { EventStreamDecoder, EventStreamError, encodeFrame, type EventStreamFrame } from '../detection/mcp/eventStream.js'

/**
 * Bedrock's streaming answers, read as text for the response scans (#906).
 *
 * `converse-stream` and `invoke-with-response-stream` answer in binary
 * `application/vnd.amazon.eventstream` frames. Since #882 the MCP tool gate
 * reads them; the other response-side checks (the markdown and HTML exfil
 * scan, tool-call argument DLP and exfil URLs, memory-poisoning writes, the
 * harmful-compliance scan and the canary watch) read decoded SSE text, so for
 * a streamed Bedrock answer they ran on nothing. Each frame is turned into the
 * Anthropic SSE event it stands for, which those scans already read: a
 * Converse text delta into a `text_delta`, a reasoning delta into a
 * `thinking_delta`, a tool call's start and argument fragments into
 * `tool_use` and `input_json_delta`; an InvokeModel `chunk` carries an
 * Anthropic event base64-encoded, or another model's text field. The frames
 * themselves are returned whole, so a caller can forward exactly the frames
 * it has read and cut the stream only at a frame boundary.
 */
export type EventStreamKind = 'converse' | 'invoke'

/** The event shape a Bedrock streaming path answers in, or null for any other path. */
export function eventStreamKind(path: string): EventStreamKind | null {
  const p = path.split('?')[0] ?? ''
  if (p.endsWith('/converse-stream')) return 'converse'
  if (p.endsWith('/invoke-with-response-stream')) return 'invoke'
  return null
}

const sse = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
const obj = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined

function converseEvent(type: string | undefined, p: Record<string, unknown>): string {
  const index = typeof p.contentBlockIndex === 'number' ? p.contentBlockIndex : 0
  switch (type) {
    case 'contentBlockStart': {
      const toolUse = obj(obj(p.start)?.toolUse)
      return toolUse ? sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolUse.toolUseId, name: toolUse.name, input: {} } }) : ''
    }
    case 'contentBlockDelta': {
      const delta = obj(p.delta)
      if (typeof delta?.text === 'string') return sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta.text } })
      const reasoning = obj(delta?.reasoningContent)
      if (typeof reasoning?.text === 'string') return sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reasoning.text } })
      const toolUse = obj(delta?.toolUse)
      if (typeof toolUse?.input === 'string') return sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: toolUse.input } })
      return ''
    }
    case 'contentBlockStop':
      return sse('content_block_stop', { type: 'content_block_stop', index })
    case 'messageStop':
      return sse('message_delta', { type: 'message_delta', delta: { stop_reason: p.stopReason } })
    default:
      return ''
  }
}

// The top-level text field of the non-Anthropic models InvokeModel streams
// for: Claude's legacy text completions, Titan, Llama, Cohere Command R, AI21.
const INVOKE_TEXT_KEYS = ['completion', 'outputText', 'generation', 'text', 'output_text'] as const
const CONVERSE_KEYS = ['contentBlockStart', 'contentBlockDelta', 'contentBlockStop', 'messageStop'] as const
const textDelta = (text: string): string => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })

/** Every string in a value, depth-first, bounded: an unknown chunk shape is still read, never skipped. */
function stringLeaves(v: unknown, out: string[], depth = 0): void {
  if (out.length >= 256 || depth > 8) return
  if (typeof v === 'string') {
    if (v) out.push(v)
    return
  }
  const children = Array.isArray(v) ? v : Object.values(obj(v) ?? {})
  for (const x of children) stringLeaves(x, out, depth + 1)
}

/** A tool call's name and arguments in the shapes other models stream them: Cohere's {name, parameters}, OpenAI-style {function: {name, arguments}}. */
function toolCallOf(v: unknown): { id?: unknown; name: string; args: string } | null {
  const o = obj(v)
  if (!o) return null
  const fn = obj(o.function)
  const name = typeof fn?.name === 'string' ? fn.name : typeof o.name === 'string' ? o.name : null
  if (!name) return null
  const raw = fn ? fn.arguments : o.parameters ?? o.arguments ?? o.input
  return { id: o.id, name, args: typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}) }
}

/** Every tool_calls list a chunk carries: at the top, in outputs[] or generations[], in choices[].message or choices[].delta. */
function toolCallLists(event: Record<string, unknown>): unknown[][] {
  const lists: unknown[][] = []
  const add = (v: unknown) => { if (Array.isArray(v)) lists.push(v) }
  add(event.tool_calls)
  for (const key of ['outputs', 'generations', 'choices'] as const) {
    const items = event[key]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const o = obj(item)
      add(o?.tool_calls)
      add(obj(o?.message)?.tool_calls)
      add(obj(o?.delta)?.tool_calls)
    }
  }
  return lists
}

function invokeEvent(type: string | undefined, p: Record<string, unknown>, nextToolIndex: () => number): string {
  if (type !== 'chunk' || typeof p.bytes !== 'string') return ''
  let event: Record<string, unknown> | undefined
  try { event = obj(JSON.parse(Buffer.from(p.bytes, 'base64').toString('utf8'))) } catch { return '' }
  if (!event) return ''
  if (typeof event.type === 'string') return sse(event.type, event)
  const fields = event
  let out = ''
  // Amazon Nova streams Converse-shaped events inside its chunks.
  for (const k of CONVERSE_KEYS) { const v = obj(fields[k]); if (v) out += converseEvent(k, v) }
  // Tool calls of the models that stream them whole (Cohere, Mistral), as
  // the tool_use events the tool-call scan reads.
  for (const list of toolCallLists(fields)) {
    for (const item of list) {
      const call = toolCallOf(item)
      if (!call) continue
      const index = nextToolIndex()
      out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
      out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.args } })
      out += sse('content_block_stop', { type: 'content_block_stop', index })
    }
  }
  // Text: the known fields first (Claude's legacy completions, Titan, Llama,
  // Cohere Command R, AI21; Mistral's outputs[].text, Cohere Command's
  // generations[].text), then every other string the chunk holds, so a field
  // nobody mapped, or a new model's shape, is still read (security review).
  const texts = INVOKE_TEXT_KEYS.map(k => fields[k]).filter((t): t is string => typeof t === 'string' && t.length > 0)
  for (const key of ['outputs', 'generations'] as const) {
    const list = fields[key]
    if (Array.isArray(list)) for (const item of list) { const t = obj(item)?.text; if (typeof t === 'string' && t) texts.push(t) }
  }
  const taken = new Set<string>([...CONVERSE_KEYS, ...INVOKE_TEXT_KEYS])
  const rest: string[] = []
  for (const [k, v] of Object.entries(fields)) if (!taken.has(k)) stringLeaves(v, rest)
  for (const t of rest) if (!texts.includes(t)) texts.push(t)
  if (texts.length) out += textDelta(texts.join('\n'))
  return out
}

/** The Anthropic SSE event a frame stands for, or '' for one that carries no text (metadata, exceptions). */
function frameToSse(kind: EventStreamKind, frame: EventStreamFrame, nextToolIndex: () => number): string {
  if (frame.headers[':message-type'] !== 'event') return ''
  let payload: Record<string, unknown> | undefined
  try { payload = obj(JSON.parse(frame.payload.toString('utf8'))) } catch { return '' }
  if (!payload) return ''
  return kind === 'converse' ? converseEvent(frame.headers[':event-type'], payload) : invokeEvent(frame.headers[':event-type'], payload, nextToolIndex)
}

export class EventStreamReader {
  private readonly decoder = new EventStreamDecoder()
  private failed = false
  // Indices for the tool_use events made from whole tool calls, clear of a model's own block indices.
  private toolIndex = 10_000
  private readonly nextToolIndex = (): number => this.toolIndex++

  constructor(private readonly kind: EventStreamKind) {}

  /**
   * The frames `chunk` completes and the SSE text each stands for. After a
   * frame that cannot be read, `error` names why and every later push
   * returns nothing: what follows an unreadable frame cannot be framed.
   */
  push(chunk: Buffer): { frames: EventStreamFrame[]; sse: string[]; error: string | null } {
    if (this.failed) return { frames: [], sse: [], error: null }
    let frames: EventStreamFrame[]
    let error: string | null = null
    try {
      frames = this.decoder.push(chunk)
    } catch (err) {
      this.failed = true
      frames = err instanceof EventStreamError ? err.frames : []
      error = err instanceof Error ? err.message : String(err)
    }
    return { frames, sse: frames.map(f => frameToSse(this.kind, f, this.nextToolIndex)), error }
  }

  /** Whether part of a frame is waiting for the rest. */
  get midFrame(): boolean {
    return this.decoder.midFrame
  }
}

/** The exception frame that ends a stream llm-fw cut, so the client's SDK reports why instead of a lost connection. */
export function eventStreamException(message: string): Buffer {
  return encodeFrame({ ':message-type': 'exception', ':exception-type': 'modelStreamErrorException', ':content-type': 'application/json' }, Buffer.from(JSON.stringify({ message })))
}
