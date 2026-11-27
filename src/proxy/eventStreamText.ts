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

// The text field of each non-Anthropic model InvokeModel streams for.
const INVOKE_TEXT_KEYS = ['completion', 'outputText', 'generation', 'text', 'output_text'] as const

function invokeEvent(type: string | undefined, p: Record<string, unknown>): string {
  if (type !== 'chunk' || typeof p.bytes !== 'string') return ''
  let event: Record<string, unknown> | undefined
  try { event = obj(JSON.parse(Buffer.from(p.bytes, 'base64').toString('utf8'))) } catch { return '' }
  if (!event) return ''
  if (typeof event.type === 'string') return sse(event.type, event)
  const fields = event
  const texts = INVOKE_TEXT_KEYS.map(k => fields[k]).filter((t): t is string => typeof t === 'string' && t.length > 0)
  return texts.length ? sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: texts.join('') } }) : ''
}

/** The Anthropic SSE event a frame stands for, or '' for one that carries no text (metadata, exceptions). */
function frameToSse(kind: EventStreamKind, frame: EventStreamFrame): string {
  if (frame.headers[':message-type'] !== 'event') return ''
  let payload: Record<string, unknown> | undefined
  try { payload = obj(JSON.parse(frame.payload.toString('utf8'))) } catch { return '' }
  if (!payload) return ''
  return kind === 'converse' ? converseEvent(frame.headers[':event-type'], payload) : invokeEvent(frame.headers[':event-type'], payload)
}

export class EventStreamReader {
  private readonly decoder = new EventStreamDecoder()
  private failed = false

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
    return { frames, sse: frames.map(f => frameToSse(this.kind, f)), error }
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
