import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'

/**
 * WebSocket support for the OpenAI Realtime API (#270) and Gemini Live (#344).
 *
 * The proxy's MITM servers had no `upgrade` listener, so Node destroyed every
 * WebSocket handshake to an intercepted host: a Realtime session could not
 * connect through llm-fw at all, and its audio was never scanned. This module
 * holds the pieces the relay in realtimeRelay.ts is built from, kept free of
 * I/O so they are unit-testable: an RFC 6455 frame codec, the per-session
 * audio buffer, and, per protocol, the decision of what to scan in each
 * client event.
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
      const payload = Buffer.from(this.buf.subarray(offset + (masked ? 4 : 0), total))
      if (masked) {
        const key = this.buf.subarray(offset, offset + 4)
        for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0)
      }
      frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload, raw: Buffer.from(raw) })
      this.buf = this.buf.subarray(total)

    }
    return frames
  }
}

/** The Realtime API's default input format: 16-bit little-endian PCM, mono, 24 kHz. */
export const REALTIME_SAMPLE_RATE = 24_000

/** Gemini Live's default input format: 16-bit little-endian PCM, mono, 16 kHz. */
export const GEMINI_LIVE_SAMPLE_RATE = 16_000

/**
 * The streamed audio chunks of one turn, as PCM16 at `sampleRate`. Stops
 * growing at `maxSeconds` (the transcriber's own cap), so a session that
 * streams audio faster than real time cannot make one scan arbitrarily
 * expensive.
 */
export class RealtimeAudioBuffer {
  private chunks: Buffer[] = []
  private bytes = 0
  truncated = false

  constructor(private readonly maxSeconds: number, readonly sampleRate = REALTIME_SAMPLE_RATE) {}

  get seconds(): number {
    return this.bytes / 2 / this.sampleRate
  }

  append(base64: string): void {
    const room = Math.floor(this.maxSeconds * this.sampleRate) * 2 - this.bytes
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
    header.writeUInt32LE(this.sampleRate, 24)
    header.writeUInt32LE(this.sampleRate * 2, 28)
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
  | {
      kind: 'body'
      body: string
      surface: 'prompt' | 'tool_result' | 'audio-item' | 'video'
      /** Replace the flagged tool output in the client event with the withheld body from pipeline.inspect(). */
      withhold?: (rewrittenBody: string) => boolean
    }

/** One streamed audio chunk, base64 PCM16. */
export interface AudioChunk { data: string; sampleRate: number }

/** What the relay does with one client message before forwarding it. */
export interface ClientMessagePlan {
  /** Audio to append to the session's buffer, in order. */
  audio: AudioChunk[]
  /** Drop the buffered audio (the client discarded its turn). */
  clearAudio: boolean
  /** Whether DLP reads the message. False when it carries only media, whose base64 is not text. */
  dlp: boolean
  /** Scans to pass before the message is forwarded; `audio` scans the buffer. */
  scans: RealtimeScan[]
}

/** A WebSocket protocol the relay can inspect. */
export interface RealtimeProtocol {
  /** For events and log lines. */
  readonly label: string
  /** Whether a JSON event in a binary frame is read like text instead of refused. */
  readonly jsonInBinary: boolean
  plan(event: Record<string, unknown>, audioBuffered: boolean): ClientMessagePlan
  /** The event a client of this protocol reads as an error, or null when only the close frame carries it. */
  errorEvent(message: string, eventId: string): Record<string, unknown> | null
}

export const OPENAI_REALTIME: RealtimeProtocol = {
  label: 'Realtime',
  jsonInBinary: false,
  plan(event, audioBuffered) {
    if (event.type === 'input_audio_buffer.append' && typeof event.audio === 'string') {
      return { audio: [{ data: event.audio, sampleRate: REALTIME_SAMPLE_RATE }], clearAudio: false, dlp: false, scans: [] }
    }
    if (event.type === 'input_audio_buffer.clear') return { audio: [], clearAudio: true, dlp: true, scans: [] }
    return { audio: [], clearAudio: false, dlp: true, scans: realtimeScansFor(event, audioBuffered) }
  },
  errorEvent(message, eventId) {
    return { type: 'error', error: { type: 'invalid_request_error', code: 'llm_fw_blocked', message, event_id: eventId } }
  },
}

/**
 * Gemini Live (`BidiGenerateContent`). Client messages carry one top-level
 * key: `setup` (developer-authored, like a system prompt), `clientContent`
 * (conversation turns), `realtimeInput` (streamed audio, video frames, text,
 * and the activity markers that end a turn) or `toolResponse`. Its server
 * reports errors by closing the socket with a reason, so a refusal does too.
 */
export const GEMINI_LIVE: RealtimeProtocol = {
  label: 'Gemini Live',
  jsonInBinary: true,
  plan(event, audioBuffered) {
    const ri = asRecord(event.realtimeInput)
    if (ri) return geminiRealtimeInput(ri, audioBuffered)
    const scans: RealtimeScan[] = []
    const cc = asRecord(event.clientContent)
    if (cc && Array.isArray(cc.turns)) scans.push(...geminiClientContent(cc.turns))
    const tr = asRecord(event.toolResponse)
    if (tr && Array.isArray(tr.functionResponses)) scans.push(...geminiToolResponse(tr.functionResponses))
    return { audio: [], clearAudio: false, dlp: true, scans }
  },
  errorEvent() {
    return null
  },
}

function geminiRealtimeInput(ri: Record<string, unknown>, audioBuffered: boolean): ClientMessagePlan {
  const media: Array<Record<string, unknown>> = []
  if (Array.isArray(ri.mediaChunks)) for (const c of ri.mediaChunks) { const r = asRecord(c); if (r) media.push(r) }
  for (const key of ['audio', 'video'] as const) { const r = asRecord(ri[key]); if (r) media.push(r) }
  const audio: AudioChunk[] = []
  const images: unknown[] = []
  for (const m of media) {
    if (typeof m.data !== 'string' || typeof m.mimeType !== 'string') continue
    if (m.mimeType.startsWith('audio/pcm')) audio.push({ data: m.data, sampleRate: pcmRate(m.mimeType) })
    else if (m.mimeType.startsWith('image/')) images.push(imagePart(m.mimeType, m.data))
  }
  const text = typeof ri.text === 'string' && ri.text ? ri.text : null
  const scans: RealtimeScan[] = []
  // The turn ends: scan what was buffered, plus this message's own audio.
  if ((ri.activityEnd || ri.audioStreamEnd) && (audioBuffered || audio.length > 0)) scans.push({ kind: 'audio' })
  if (images.length) scans.push({ kind: 'body', surface: 'video', body: chatBody([{ role: 'user', content: images }]) })
  if (text !== null) scans.push({ kind: 'body', surface: 'prompt', body: chatBody([{ role: 'user', content: [{ type: 'text', text }] }]) })
  // Only media: DLP would read base64, and a random run of it can look like a key.
  return { audio, clearAudio: false, dlp: text !== null, scans }
}

function geminiClientContent(turns: unknown[]): RealtimeScan[] {
  const messages: unknown[] = []
  let hasAudio = false
  for (const t of turns) {
    const turn = asRecord(t)
    // Model turns are history, skipped like assistant messages on the HTTP path.
    if (!turn || turn.role === 'model' || !Array.isArray(turn.parts)) continue
    const content: unknown[] = []
    for (const p of turn.parts) {
      const part = asRecord(p)
      if (typeof part?.text === 'string') content.push({ type: 'text', text: part.text })
      const inline = asRecord(part?.inlineData)
      if (!inline || typeof inline.data !== 'string' || typeof inline.mimeType !== 'string') continue
      if (inline.mimeType.startsWith('audio/pcm')) {
        const buf = new RealtimeAudioBuffer(Number.POSITIVE_INFINITY, pcmRate(inline.mimeType))
        buf.append(inline.data)
        content.push({ type: 'input_audio', input_audio: { data: buf.toWav().toString('base64'), format: 'wav' } })
        hasAudio = true
      } else if (inline.mimeType.startsWith('image/')) {
        content.push(imagePart(inline.mimeType, inline.data))
      }
    }
    if (content.length) messages.push({ role: 'user', content })
  }
  return messages.length ? [{ kind: 'body', surface: hasAudio ? 'audio-item' : 'prompt', body: chatBody(messages) }] : []
}

function geminiToolResponse(responses: unknown[]): RealtimeScan[] {
  const records = responses.map(f => asRecord(f))
  const messages = records.map(fr => {
    const id = typeof fr?.id === 'string' ? fr.id : typeof fr?.name === 'string' ? fr.name : 'gemini-live'
    return { role: 'tool', tool_call_id: id, content: JSON.stringify(fr?.response ?? {}) }
  })
  if (!messages.length) return []
  return [{
    kind: 'body',
    surface: 'tool_result',
    body: chatBody(messages),
    withhold(rewrittenBody) {
      try {
        const parsed = JSON.parse(rewrittenBody) as { messages?: Array<{ content?: unknown }> }
        const nextMessages = parsed.messages
        if (!Array.isArray(nextMessages) || nextMessages.length !== records.length) return false
        let changed = false
        for (let i = 0; i < records.length; i++) {
          const fr = records[i]
          const next = nextMessages[i]?.content
          if (!fr || typeof next !== 'string') return false
          if (next !== messages[i]!.content) {
            fr.response = { output: next }
            changed = true
          }
        }
        return changed
      } catch {
        return false
      }
    },
  }]
}

function imagePart(mimeType: string, data: string): unknown {
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
}

const GEMINI_LIVE_PATH_RE = /^\/ws\/google\.ai\.generativelanguage\.v1(?:alpha|beta)?\.GenerativeService\.BidiGenerateContent(?:Constrained)?(?:[/?]|$)/

/** Why a WebSocket path is answered 501, on the proxy and the gateway. */
export const WS_NOT_INSPECTABLE = 'llm-fw relays only the OpenAI Realtime API (/v1/realtime) and Gemini Live (BidiGenerateContent) over WebSocket; this path is refused rather than tunnelled unscanned.'

// The Responses API over WebSocket: what Codex CLI opens first, on
// api.openai.com and on chatgpt.com's Codex backend. It is not relayed, but
// the same request over HTTP is inspected, and Codex switches to HTTP for the
// rest of the session at once on 426 (codex-rs core/src/client.rs, both
// WebSocket connect paths). A 501 it retried five times first, about 4.5 s
// per session, measured live (#566).
const RESPONSES_WS_PATH_RE = /^\/(?:v1\/responses|backend-api\/codex\/responses)(?:[/?]|$)/
export const WS_USE_HTTP = 'llm-fw does not relay the Responses API over WebSocket; send the request over HTTP, which it inspects.'

/** How to refuse a WebSocket path the relay cannot inspect: 426 where the client has an HTTP route, 501 otherwise. */
export function wsRefusal(path: string): { status: 426 | 501; reason: string; detail: string } {
  return RESPONSES_WS_PATH_RE.test(path.replace(/\/{2,}/g, '/'))
    ? { status: 426, reason: 'Upgrade Required', detail: WS_USE_HTTP }
    : { status: 501, reason: 'Not Implemented', detail: WS_NOT_INSPECTABLE }
}

/** The protocol a WebSocket path speaks, or null when the relay cannot inspect it. */
export function realtimeProtocolFor(path: string): RealtimeProtocol | null {
  if (/^\/v1\/realtime(?:[/?]|$)/.test(path)) return OPENAI_REALTIME
  if (GEMINI_LIVE_PATH_RE.test(path)) return GEMINI_LIVE
  return null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

/** `audio/pcm;rate=24000` names its rate; plain `audio/pcm` is Gemini Live's 16 kHz. */
function pcmRate(mimeType: string): number {
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1])
  return rate >= 8_000 && rate <= 48_000 ? rate : GEMINI_LIVE_SAMPLE_RATE
}

function chatBody(messages: unknown[]): string {
  return JSON.stringify({ model: 'realtime', messages })
}

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
    return {
      kind: 'body',
      surface: 'tool_result',
      body: JSON.stringify({ model: 'realtime', messages: [{ role: 'tool', tool_call_id: typeof item.call_id === 'string' ? item.call_id : 'realtime', content: item.output }] }),
      withhold(rewrittenBody) {
        try {
          const parsed = JSON.parse(rewrittenBody) as { messages?: Array<{ content?: unknown }> }
          const next = parsed.messages?.[0]?.content
          if (typeof next !== 'string') return false
          item.output = next
          return true
        } catch {
          return false
        }
      },
    }
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

/**
 * Write an unmasked (server-to-client) error event when the protocol has one,
 * and a close frame whose reason is capped at the 123 bytes RFC 6455 allows,
 * then end the socket.
 */
export function refuseRealtime(client: Duplex, errorEvent: Record<string, unknown> | null, reason: string, code = 1008): void {
  try {
    if (errorEvent) client.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(errorEvent)), false))
    const close = Buffer.alloc(2 + Buffer.byteLength(reason.slice(0, 120)))
    close.writeUInt16BE(code, 0) // 1008 policy violation, 1009 message too big
    close.write(reason.slice(0, 120), 2)
    client.write(encodeFrame(OPCODE.close, close, false))
  } catch { /* client already gone */ }
  client.end()
  // A client that never answers the close frame would hold the tunnel open.
  setTimeout(() => client.destroy(), 2000).unref()
}
