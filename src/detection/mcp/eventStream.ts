/**
 * AWS event-stream framing (`application/vnd.amazon.eventstream`), which
 * Bedrock's streaming endpoints answer in (#882): `converse-stream` and
 * `invoke-with-response-stream`. A frame is a 12-byte prelude (total length,
 * headers length, CRC32 of those 8 bytes), the headers, the payload, then the
 * CRC32 of everything before it, all integers big-endian.
 *
 * The decoder keeps a frame's pieces until it is whole and joins them once,
 * so it is linear in the stream, and refuses a frame whose length passes
 * MAX_FRAME_BYTES before reading it. A checksum that does not match is an
 * error: a frame nobody can read is never passed on as if it were checked.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024 + 1024

export class EventStreamError extends Error {
  /** The frames the same push completed before the one that failed. */
  frames: EventStreamFrame[] = []
  constructor(message: string) {
    super(message)
    this.name = 'EventStreamError'
  }
}

export interface EventStreamFrame {
  /** String-valued headers by name; other header types are kept only in `headersRaw`. */
  headers: Record<string, string>
  headersRaw: Buffer
  payload: Buffer
  /** The frame exactly as it arrived. */
  raw: Buffer
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32 (IEEE), as the framing uses. Computed here because zlib.crc32 arrived in Node 22.2. */
export function crc32(buf: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// Bytes a header value of each type takes after its type byte; -1: a 2-byte length follows.
const HEADER_VALUE_BYTES: Readonly<Record<number, number>> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 6: -1, 7: -1, 8: 8, 9: 16 }

function parseHeaders(raw: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < raw.length) {
    const nameLen = raw[i]!
    const name = raw.toString('utf8', i + 1, i + 1 + nameLen)
    i += 1 + nameLen
    if (i >= raw.length) throw new EventStreamError('header without a value type')
    const type = raw[i]!
    i += 1
    const fixed = HEADER_VALUE_BYTES[type]
    if (fixed === undefined) throw new EventStreamError(`unknown header value type ${type}`)
    if (fixed === -1) {
      if (i + 2 > raw.length) throw new EventStreamError('truncated header value')
      const len = raw.readUInt16BE(i)
      i += 2
      if (i + len > raw.length) throw new EventStreamError('truncated header value')
      if (type === 7) out[name] = raw.toString('utf8', i, i + len)
      i += len
    } else {
      if (i + fixed > raw.length) throw new EventStreamError('truncated header value')
      i += fixed
    }
  }
  return out
}

/** Encode string headers the way the decoder reads them. */
function encodeHeaders(headers: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, 'utf8')
    const v = Buffer.from(value, 'utf8')
    const head = Buffer.alloc(1 + n.length + 3)
    head[0] = n.length
    n.copy(head, 1)
    head[1 + n.length] = 7
    head.writeUInt16BE(v.length, 2 + n.length)
    parts.push(head, v)
  }
  return Buffer.concat(parts)
}

/** A frame with `headers` (string headers, or the raw bytes of a decoded frame's) and `payload`. */
export function encodeFrame(headers: Record<string, string> | Buffer, payload: Buffer): Buffer {
  const h = Buffer.isBuffer(headers) ? headers : encodeHeaders(headers)
  const total = 12 + h.length + payload.length + 4
  const out = Buffer.alloc(total)
  out.writeUInt32BE(total, 0)
  out.writeUInt32BE(h.length, 4)
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8)
  h.copy(out, 12)
  payload.copy(out, 12 + h.length)
  out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4)
  return out
}

export class EventStreamDecoder {
  private pending: Buffer[] = []
  private pendingBytes = 0
  // The length of the frame being read, once its prelude is in.
  private expected = 0

  /** The frames completed by `chunk`. Throws EventStreamError on a malformed frame. */
  push(chunk: Buffer): EventStreamFrame[] {
    if (chunk.length) {
      this.pending.push(chunk)
      this.pendingBytes += chunk.length
    }
    const frames: EventStreamFrame[] = []
    try {
      this.readFrames(frames)
    } catch (err) {
      if (err instanceof EventStreamError) err.frames = frames
      throw err
    }
    return frames
  }

  private readFrames(frames: EventStreamFrame[]): void {
    for (;;) {
      if (this.expected === 0) {
        if (this.pendingBytes < 12) break
        const prelude = this.take(12, false)
        const total = prelude.readUInt32BE(0)
        const headersLen = prelude.readUInt32BE(4)
        if (crc32(prelude.subarray(0, 8)) !== prelude.readUInt32BE(8)) throw new EventStreamError('prelude checksum does not match')
        if (total > MAX_FRAME_BYTES) throw new EventStreamError(`frame of ${total} bytes is over the ${MAX_FRAME_BYTES}-byte cap`)
        if (total < 16 || headersLen > total - 16) throw new EventStreamError('frame lengths are inconsistent')
        this.expected = total
      }
      if (this.pendingBytes < this.expected) break
      const raw = this.take(this.expected, true)
      this.expected = 0
      const headersLen = raw.readUInt32BE(4)
      if (crc32(raw.subarray(0, raw.length - 4)) !== raw.readUInt32BE(raw.length - 4)) throw new EventStreamError('message checksum does not match')
      const headersRaw = raw.subarray(12, 12 + headersLen)
      frames.push({ headers: parseHeaders(headersRaw), headersRaw, payload: raw.subarray(12 + headersLen, raw.length - 4), raw })
    }
  }

  /** Whether part of a frame is waiting for the rest. */
  get midFrame(): boolean {
    return this.pendingBytes > 0
  }

  /** The first `n` pending bytes, removed when `consume`, else only looked at. */
  private take(n: number, consume: boolean): Buffer {
    const all = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending)
    this.pending = [all]
    const head = all.subarray(0, n)
    if (consume) {
      const rest = all.subarray(n)
      this.pending = rest.length ? [rest] : []
      this.pendingBytes = rest.length
    }
    return head
  }
}
