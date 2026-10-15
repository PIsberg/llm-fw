import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'

/**
 * WebSocket support for the OpenAI Realtime API (#270).
 *
 * The proxy's MITM servers had no `upgrade` listener, so Node destroyed every
 * WebSocket handshake to an intercepted host: a Realtime session could not
 * connect through llm-fw at all, and its audio was never scanned. This module
 * holds the pieces the relay in proxy.ts is built from, kept free of I/O so
 * they are unit-testable: an RFC 6455 frame codec, the per-session audio
 * buffer, and the decision of what to scan in each client event.
 */

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

export interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
  /** The frame exactly as received, so a relay can forward it untouched. */
  raw: Buffer
}

/** Encode one frame. Client-to-server frames must be masked (RFC 6455 5.3). */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean, fin = true): Buffer {
  const len = payload.length
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10
  const out = Buffer.alloc(head + (mask ? 4 : 0) + len)
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  if (len < 126) out[1] = len
  else if (len < 65536) { out[1] = 126; out.writeUInt16BE(len, 2) }
  else { out[1] = 127; out.writeBigUInt64BE(BigInt(len), 2) }
  if (!mask) { payload.copy(out, head); return out }
  out[1] = (out[1] ?? 0) | 0x80
  // RFC 6455 10.3: the masking key must be unpredictable.
  const key = randomBytes(4)
  key.copy(out, head)
  for (let i = 0; i < len; i++) out[head + 4 + i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0)
  return out
}

/**
 * Incremental frame parser. `push` returns every complete frame in the bytes
 * seen so far and keeps the remainder. A frame longer than `maxPayload` throws
 * rather than being buffered: the relay closes the session instead of holding
 * an unbounded message in memory. Extensions are never negotiated (the relay
 * strips Sec-WebSocket-Extensions), so any RSV bit is a protocol error.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)

  constructor(private readonly maxPayload = 16 * 1024 * 1024) {}

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const frames: Frame[] = []
    for (;;) {
      if (this.buf.length < 2) break
      const b0 = this.buf[0] ?? 0
      const b1 = this.buf[1] ?? 0
      if (b0 & 0x70) throw new Error('websocket frame uses an extension that was not negotiated')
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2
      if (len === 126) {
        if (this.buf.length < 4) break
        len = this.buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this.buf.length < 10) break
        const big = this.buf.readBigUInt64BE(2)
        if (big > BigInt(this.maxPayload)) throw new Error('websocket frame too large')
        len = Number(big)
        offset = 10
      }
      if (len > this.maxPayload) throw new Error('websocket frame too large')
      const total = offset + (masked ? 4 : 0) + len
      if (this.buf.length < total) break
      const raw = this.buf.subarray(0, total)
      let payload = Buffer.from(this.buf.subarray(offset + (masked ? 4 : 0), total))
      if (masked) {
        const key = this.buf.subarray(offset, offset + 4)
        for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0)
      }
      frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload, raw: Buffer.from(raw) })
      this.buf = this.buf.subarray(total)
      payload = Buffer.alloc(0)
    }
    return frames
  }
}

/** The Realtime API's default input format: 16-bit little-endian PCM, mono, 24 kHz. */
export const REALTIME_SAMPLE_RATE = 24_000

/**
 * The `input_audio_buffer.append` chunks of one turn, as PCM16. Stops growing
 * at `maxSeconds` (the transcriber's own cap), so a session that streams audio
 * faster than real time cannot make one scan arbitrarily expensive.
 */
export class RealtimeAudioBuffer {
  private chunks: Buffer[] = []
  private bytes = 0
  truncated = false

  constructor(private readonly maxSeconds: number) {}

  get seconds(): number {
    return this.bytes / 2 / REALTIME_SAMPLE_RATE
  }

  append(base64: string): void {
    const room = Math.floor(this.maxSeconds * REALTIME_SAMPLE_RATE) * 2 - this.bytes
    if (room <= 0) { this.truncated = true; return }
    let pcm = Buffer.from(base64, 'base64')
    if (pcm.length > room) { pcm = pcm.subarray(0, room - (room % 2)); this.truncated = true }
    this.chunks.push(pcm)
    this.bytes += pcm.length
  }

  clear(): void {
    this.chunks = []
    this.bytes = 0
    this.truncated = false
  }

  /** The buffered audio as a RIFF/WAVE file, which the transcriber decodes. */
  toWav(): Buffer {
    const data = Buffer.concat(this.chunks, this.bytes)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'latin1')
    header.writeUInt32LE(36 + data.length, 4)
    header.write('WAVE', 8, 'latin1')
    header.write('fmt ', 12, 'latin1')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20) // PCM
    header.writeUInt16LE(1, 22) // mono
    header.writeUInt32LE(REALTIME_SAMPLE_RATE, 24)
    header.writeUInt32LE(REALTIME_SAMPLE_RATE * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36, 'latin1')
    header.writeUInt32LE(data.length, 40)
    return Buffer.concat([header, data])
  }
}

/** What to scan before forwarding one client event, as a chat-completions body the pipeline already parses. */
export type RealtimeScan =
  | { kind: 'none' }
  | { kind: 'audio' }
  | { kind: 'body'; body: string; surface: 'prompt' | 'tool_result' | 'audio-item' }

/**
 * Decide what one client event needs scanned; empty means forward as is.
 * Audio is scanned when the turn is committed (`input_audio_buffer.commit`, or
 * `response.create` with audio buffered); text and tool output when they enter
 * the conversation, whether through `conversation.item.create` or the
 * out-of-band `input` items of a `response.create`. Developer-authored text
 * (`session.update` and `response.create` instructions, `system`-role items)
 * passes like a system prompt does on the HTTP path, and assistant items are
 * history, skipped there too.
 */
export function realtimeScansFor(event: Record<string, unknown>, audioBuffered: boolean): RealtimeScan[] {
  const type = event.type
  if (type === 'input_audio_buffer.commit') return audioBuffered ? [{ kind: 'audio' }] : []
  if (type === 'response.create') {
    const scans: RealtimeScan[] = audioBuffered ? [{ kind: 'audio' }] : []
    const input = (event.response as Record<string, unknown> | undefined)?.input
    if (Array.isArray(input)) {
      for (const item of input) {
        const scan = itemScan(item as Record<string, unknown> | undefined)
        if (scan.kind !== 'none') scans.push(scan)
      }
    }
    return scans
  }
  if (type !== 'conversation.item.create') return []
  const scan = itemScan(event.item as Record<string, unknown> | undefined)
  return scan.kind === 'none' ? [] : [scan]
}

function itemScan(item: Record<string, unknown> | undefined): RealtimeScan {
  if (!item || typeof item !== 'object') return { kind: 'none' }
  if (item.type === 'function_call_output' && typeof item.output === 'string') {
    return { kind: 'body', surface: 'tool_result', body: JSON.stringify({ model: 'realtime', messages: [{ role: 'tool', tool_call_id: typeof item.call_id === 'string' ? item.call_id : 'realtime', content: item.output }] }) }
  }
  if (item.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content)) return { kind: 'none' }
  const parts: unknown[] = []
  for (const part of item.content as Array<Record<string, unknown>>) {
    if (part?.type === 'input_text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text })
    // A whole clip attached to an item: PCM16, which the transcriber reads as WAV.
    if (part?.type === 'input_audio' && typeof part.audio === 'string') {
      const buf = new RealtimeAudioBuffer(Number.POSITIVE_INFINITY)
      buf.append(part.audio)
      parts.push({ type: 'input_audio', input_audio: { data: buf.toWav().toString('base64'), format: 'wav' } })
    }
  }
  if (!parts.length) return { kind: 'none' }
  const hasAudio = parts.some(p => (p as { type: string }).type === 'input_audio')
  return { kind: 'body', surface: hasAudio ? 'audio-item' : 'prompt', body: JSON.stringify({ model: 'realtime', messages: [{ role: 'user', content: parts }] }) }
}

/** The chat-completions body that scans a committed audio turn. */
export function audioScanBody(wav: Buffer): string {
  return JSON.stringify({ model: 'realtime', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }] }] })
}

/** Write an unmasked (server-to-client) text frame and a close frame, then end the socket. */
export function refuseRealtime(client: Duplex, errorEvent: Record<string, unknown>, reason: string): void {
  try {
    client.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(errorEvent)), false))
    const close = Buffer.alloc(2 + Buffer.byteLength(reason.slice(0, 120)))
    close.writeUInt16BE(1008, 0) // policy violation
    close.write(reason.slice(0, 120), 2)
    client.write(encodeFrame(OPCODE.close, close, false))
  } catch { /* client already gone */ }
  client.end()
  // A client that never answers the close frame would hold the tunnel open.
  setTimeout(() => client.destroy(), 2000).unref()
}
