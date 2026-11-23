import { describe, it, expect } from 'vitest'
import { underMs, LINEAR_TIME_TIMEOUT } from '../../linearTime.js'
import zlib from 'node:zlib'
import { EventStreamDecoder, encodeFrame, crc32, EventStreamError, MAX_FRAME_BYTES } from '../../../src/detection/mcp/eventStream.js'

// #882: AWS event-stream framing (Bedrock converse-stream and
// invoke-with-response-stream): a 12-byte prelude (total length, headers
// length, prelude CRC32), headers, payload, then the CRC32 of all before it.
describe('event-stream framing', () => {
  const headers = { ':event-type': 'contentBlockDelta', ':content-type': 'application/json', ':message-type': 'event' }
  const payload = Buffer.from(JSON.stringify({ contentBlockIndex: 0, delta: { text: 'hello' } }))

  it('computes the CRC32 zlib does', () => {
    const z = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32
    const data = Buffer.from('The quick brown fox jumps over the lazy dog')
    expect(crc32(data)).toBe(0x414fa339)
    if (z) expect(crc32(payload)).toBe(z(payload))
  })

  it('round-trips a frame, split anywhere', () => {
    const frame = encodeFrame(headers, payload)
    expect(frame.readUInt32BE(0)).toBe(frame.length)
    const stream = Buffer.concat([frame, encodeFrame({ ...headers, ':event-type': 'messageStop' }, Buffer.from('{"stopReason":"end_turn"}'))])
    for (const step of [1, 7, stream.length]) {
      const dec = new EventStreamDecoder()
      const frames = []
      for (let i = 0; i < stream.length; i += step) frames.push(...dec.push(stream.subarray(i, i + step)))
      expect(frames.map(f => f.headers[':event-type'])).toEqual(['contentBlockDelta', 'messageStop'])
      expect(frames[0]!.payload.toString()).toBe(payload.toString())
      expect(Buffer.concat(frames.map(f => f.raw)).equals(stream)).toBe(true)
    }
  })

  it('refuses a frame whose prelude or message checksum does not match', () => {
    const frame = encodeFrame(headers, payload)
    const badPrelude = Buffer.from(frame); badPrelude[9] ^= 0xff
    const badMessage = Buffer.from(frame); badMessage[frame.length - 20] ^= 0xff
    expect(() => new EventStreamDecoder().push(badPrelude)).toThrow(EventStreamError)
    expect(() => new EventStreamDecoder().push(badMessage)).toThrow(EventStreamError)
  })

  it('refuses a frame that claims more than the size cap, before reading it', () => {
    const head = Buffer.alloc(12)
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    head.writeUInt32BE(0, 4)
    head.writeUInt32BE(crc32(head.subarray(0, 8)), 8)
    expect(() => new EventStreamDecoder().push(head)).toThrow(EventStreamError)
  })

  it('reads every header type a frame may carry', () => {
    const raw = Buffer.concat([
      Buffer.from([4]), Buffer.from('flag'), Buffer.from([0]),
      Buffer.from([3]), Buffer.from('num'), Buffer.from([4, 0, 0, 0, 7]),
      Buffer.from([11]), Buffer.from(':event-type'), Buffer.from([7, 0, 5]), Buffer.from('chunk'),
    ])
    const total = 12 + raw.length + 2 + 4
    const prelude = Buffer.alloc(12)
    prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(raw.length, 4); prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8)
    const body = Buffer.concat([prelude, raw, Buffer.from('{}')])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
    const [f] = new EventStreamDecoder().push(Buffer.concat([body, crc]))
    expect(f!.headers[':event-type']).toBe('chunk')
    expect(f!.payload.toString()).toBe('{}')
  })
})

describe('event-stream decoding stays linear (#882)', () => {
  it('reads a 12 MB frame sent in 4 KB chunks in linear time', { timeout: LINEAR_TIME_TIMEOUT }, () => {
    const big = encodeFrame({ ':event-type': 'chunk', ':message-type': 'event' }, Buffer.alloc(12 * 1024 * 1024, 0x61))
    const ms = underMs(500, () => {
      const dec = new EventStreamDecoder()
      let n = 0
      for (let i = 0; i < big.length; i += 4096) n += dec.push(big.subarray(i, i + 4096)).length
      expect(n).toBe(1)
    })
    expect(ms).toBeLessThan(500)
  })
})
