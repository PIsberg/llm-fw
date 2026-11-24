import { McpScanner } from './scanner.js'
import { SseToolGate, type ToolDecision } from './responseGate.js'
import { EventStreamDecoder, EventStreamError, encodeFrame, type EventStreamFrame } from './eventStream.js'

/**
 * The MCP tool gate for Bedrock's binary event streams (#882):
 * `converse-stream` and `invoke-with-response-stream`. Before, the proxy
 * gated only SSE and JSON, and passed these through unread.
 *
 * Each frame is read as the Anthropic event it stands for and the proven
 * Anthropic gate (SseToolGate) decides: a Converse `contentBlockStart` with a
 * `toolUse` is a tool block's start, its `toolUse.input` deltas the argument
 * fragments, `contentBlockStop` its end and `messageStop` the stop reason;
 * an InvokeModel `chunk` carries an Anthropic event, base64-encoded. What the
 * gate passes unchanged goes out as the frame that arrived, byte for byte;
 * what it drops is dropped; what it rewrites (the stop reason, once a call
 * was dropped) is encoded again with fresh checksums. Frames the gate does
 * not read (metadata, exceptions) keep their place in the stream.
 *
 * A frame that cannot be read (a checksum, a length) ends what is forwarded
 * and is reported as a block: a stream nobody could check is never passed on.
 */
export interface BinaryGate {
  push(chunk: Buffer): { forward: Buffer; decisions: ToolDecision[] }
  flush(): Buffer
}

interface Adapter {
  /** The Anthropic event a frame stands for, or null for a frame the gate does not read. */
  toEvent(frame: EventStreamFrame, payload: Record<string, unknown>): { type: string; data: Record<string, unknown> } | null
  /** The frame again, carrying the gate's rewrite of its event; null when that frame may not be rewritten. */
  fromEvent(frame: EventStreamFrame, payload: Record<string, unknown>, data: Record<string, unknown>): Buffer | null
}

const converse: Adapter = {
  toEvent(frame, p) {
    const index = typeof p.contentBlockIndex === 'number' ? p.contentBlockIndex : undefined
    switch (frame.headers[':event-type']) {
      case 'contentBlockStart': {
        const toolUse = (p.start as Record<string, unknown> | undefined)?.toolUse as Record<string, unknown> | undefined
        const block = toolUse
          ? { type: 'tool_use', id: toolUse.toolUseId, name: toolUse.name, input: {} }
          : { type: 'other' }
        return { type: 'content_block_start', data: { type: 'content_block_start', index, content_block: block } }
      }
      case 'contentBlockDelta': {
        const delta = p.delta as Record<string, unknown> | undefined
        const toolUse = delta?.toolUse as Record<string, unknown> | undefined
        const d = toolUse && typeof toolUse.input === 'string'
          ? { type: 'input_json_delta', partial_json: toolUse.input }
          : { type: 'other' }
        return { type: 'content_block_delta', data: { type: 'content_block_delta', index, delta: d } }
      }
      case 'contentBlockStop':
        return { type: 'content_block_stop', data: { type: 'content_block_stop', index } }
      case 'messageStop':
        return { type: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: p.stopReason } } }
      default:
        return null
    }
  },
  fromEvent(frame, p, data) {
    // Only the stop reason is ever rewritten; nothing else is re-encoded.
    if (frame.headers[':event-type'] !== 'messageStop') return null
    const stop = (data.delta as Record<string, unknown> | undefined)?.stop_reason
    return encodeFrame(frame.headersRaw, Buffer.from(JSON.stringify({ ...p, stopReason: stop })))
  },
}

const invoke: Adapter = {
  toEvent(frame, p) {
    if (frame.headers[':event-type'] !== 'chunk' || typeof p.bytes !== 'string') return null
    try {
      const event = JSON.parse(Buffer.from(p.bytes, 'base64').toString('utf8')) as Record<string, unknown>
      return typeof event.type === 'string' ? { type: event.type, data: event } : null
    } catch {
      return null
    }
  },
  fromEvent(frame, p, data) {
    return encodeFrame(frame.headersRaw, Buffer.from(JSON.stringify({ ...p, bytes: Buffer.from(JSON.stringify(data)).toString('base64') })))
  },
}

interface Entry {
  /** Carried through the gate on the event's `id:` line, to pair what it forwards with this frame. */
  id?: number
  frame: EventStreamFrame
  payload?: Record<string, unknown>
  /** The SSE event handed to the gate; absent for a frame the gate does not read. */
  sse?: string
  type?: string
  /** What to forward: the frame's bytes, a rewrite, or null when dropped; undefined while undecided. */
  out?: Buffer | null
}

class EventStreamToolGate implements BinaryGate {
  private readonly decoder = new EventStreamDecoder()
  private readonly inner: SseToolGate
  private queue: Entry[] = []
  private broken = false
  private nextId = 0

  constructor(mcp: McpScanner, private readonly adapter: Adapter) {
    this.inner = new SseToolGate(mcp)
  }

  push(chunk: Buffer): { forward: Buffer; decisions: ToolDecision[] } {
    const decisions: ToolDecision[] = []
    if (this.broken) return { forward: Buffer.alloc(0), decisions }
    let frames: EventStreamFrame[]
    let failure: unknown = null
    try {
      frames = this.decoder.push(chunk)
    } catch (err) {
      failure = err
      frames = err instanceof EventStreamError ? err.frames : []
    }
    for (const frame of frames) {
      const entry = this.read(frame)
      this.queue.push(entry)
      if (entry.sse === undefined) continue
      const r = this.inner.push(entry.sse)
      decisions.push(...r.decisions)
      this.match(r.forward)
      if (!this.inner.isHolding()) this.settle()
    }
    if (failure !== null) {
      this.broken = true
      decisions.push({ toolName: '(unreadable event stream)', action: 'block', reason: `the Bedrock event stream could not be read (${failure instanceof Error ? failure.message : 'unknown error'}); nothing from there on was forwarded` })
      // What the gate still holds was never decided, so it is dropped.
      for (const e of this.queue) if (e.sse !== undefined && e.out === undefined) e.out = null
    }
    return { forward: this.emitReady(), decisions }
  }

  flush(): Buffer {
    if (!this.broken) this.match(this.inner.flush())
    // Whatever the gate never gave back was held and dropped.
    this.settle()
    // A frame cut off by the end of the stream is never forwarded.
    return this.emitReady()
  }

  private read(frame: EventStreamFrame): Entry {
    if (frame.headers[':message-type'] !== 'event') return { frame }
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>
    } catch {
      return { frame }
    }
    const ev = this.adapter.toEvent(frame, payload)
    if (!ev) return { frame }
    const id = this.nextId++
    return { id, frame, payload, type: ev.type, sse: `id: ${id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n` }
  }

  /**
   * Pair what the gate forwarded with the frames it came from, by identity
   * (commit security review of #882: paired by event type, a passed delta of
   * one block took the place of a blocked call's dropped delta, and that
   * frame's payload, the blocked call's arguments, went out). An event the
   * gate passes keeps its `id:` line, so it is that frame, byte for byte. The
   * one event the gate rewrites, the stop reason once a call was dropped,
   * carries no id: it is paired only with an undecided stop frame. An event
   * that cannot be paired is not forwarded.
   *
   * The gate does not keep the order of its input across blocks: a held block
   * released with a second held block inside it sends its own events first
   * (#916). So a frame is never taken as dropped because a later one was
   * paired, which dropped the inner block's start; it is dropped only by
   * settle(), once the gate holds nothing.
   */
  private match(text: string): void {
    if (!text) return
    for (const sse of text.split(/(?<=\n\n)/)) {
      const idLine = /^id: (\d+)$/m.exec(sse)?.[1]
      const at = idLine !== undefined
        ? this.queue.findIndex(e => e.id === Number(idLine) && e.out === undefined && e.sse === sse)
        : this.queue.findIndex(e => e.sse !== undefined && e.out === undefined && e.type === 'message_delta')
      if (at === -1) continue
      const e = this.queue[at]!
      if (idLine !== undefined) {
        e.out = e.frame.raw
      } else {
        const data = /^data: (.*)$/m.exec(sse)?.[1]
        e.out = data ? this.adapter.fromEvent(e.frame, e.payload!, JSON.parse(data) as Record<string, unknown>) : null
      }
    }
  }

  /** With nothing held, the gate has forwarded or dropped every event pushed: what it did not forward was dropped. */
  private settle(): void {
    for (const e of this.queue) if (e.sse !== undefined && e.out === undefined) e.out = null
  }

  /** Forward, in order, every frame up to the first the gate has not decided. */
  private emitReady(): Buffer {
    const out: Buffer[] = []
    let ready = 0
    for (; ready < this.queue.length; ready++) {
      const e = this.queue[ready]!
      if (e.sse !== undefined && e.out === undefined) break
      if (e.sse === undefined) out.push(e.frame.raw)
      else if (e.out) out.push(e.out)
    }
    // One splice, not a shift per frame: a long held block is released at once.
    if (ready) this.queue.splice(0, ready)
    return out.length === 1 ? out[0]! : Buffer.concat(out)
  }
}

/** The gate for a Bedrock streaming path, or null for any other. */
export function createEventStreamGate(path: string, mcp: McpScanner): BinaryGate | null {
  const p = path.split('?')[0] ?? ''
  if (p.endsWith('/converse-stream')) return new EventStreamToolGate(mcp, converse)
  if (p.endsWith('/invoke-with-response-stream')) return new EventStreamToolGate(mcp, invoke)
  return null
}
