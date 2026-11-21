import { describe, it, expect } from 'vitest'
import { ChunkedDecoder } from '../../../src/proxy/dechunk.js'

// Build a chunked-transfer-encoded buffer from a payload string.
function chunked(payload: string, chunkSize = 8): Buffer {
  const parts: Buffer[] = []
  for (let i = 0; i < payload.length; i += chunkSize) {
    const slice = payload.slice(i, i + chunkSize)
    parts.push(Buffer.from(`${slice.length.toString(16)}\r\n${slice}\r\n`))
  }
  parts.push(Buffer.from('0\r\n\r\n')) // terminating chunk
  return Buffer.concat(parts)
}

describe('ChunkedDecoder', () => {
  it('decodes a single-pass chunked body back to the original payload', () => {
    const payload = 'Hello, streaming world! This spans several chunks.'
    const dec = new ChunkedDecoder()
    const out = dec.push(chunked(payload, 8))
    expect(out.toString('utf8')).toBe(payload)
    expect(dec.finished).toBe(true)
  })

  it('reassembles correctly when raw bytes are fed in arbitrary slices', () => {
    const payload = 'event: content_block_start\ndata: {"type":"tool_use"}\n\n'
    const raw = chunked(payload, 5)
    const dec = new ChunkedDecoder()
    let out = Buffer.alloc(0)
    // Feed one byte at a time — boundaries land mid-size-line and mid-data.
    for (let i = 0; i < raw.length; i++) {
      out = Buffer.concat([out, dec.push(raw.subarray(i, i + 1))])
    }
    expect(out.toString('utf8')).toBe(payload)
    expect(dec.finished).toBe(true)
  })

  it('handles chunk-size lines carrying extensions', () => {
    const dec = new ChunkedDecoder()
    const raw = Buffer.from('5;name=value\r\nhello\r\n0\r\n\r\n')
    expect(dec.push(raw).toString('utf8')).toBe('hello')
  })

  it('terminates on the zero-length chunk and ignores trailers', () => {
    const dec = new ChunkedDecoder()
    const raw = Buffer.from('3\r\nabc\r\n0\r\nX-Trailer: junk\r\n\r\n')
    expect(dec.push(raw).toString('utf8')).toBe('abc')
    expect(dec.finished).toBe(true)
  })

  // #670: a kept-alive upstream connection is handed to the next request only
  // once the whole message is read, the CRLF after the trailers included; a
  // byte left over would open the next response.
  it('is complete only once the trailer section has ended, however the bytes arrive', () => {
    const dec = new ChunkedDecoder()
    dec.push(Buffer.from('3\r\nabc\r\n0\r\n'))
    expect(dec.finished).toBe(true)
    expect(dec.complete).toBe(false)
    dec.push(Buffer.from('X-Tr'))
    dec.push(Buffer.from('ailer: junk\r\n'))
    expect(dec.complete).toBe(false)
    dec.push(Buffer.from('\r\n'))
    expect(dec.complete).toBe(true)
    expect(dec.excess).toBe(0)
  })

  it('counts bytes after the end of the message as excess', () => {
    const dec = new ChunkedDecoder()
    expect(dec.push(Buffer.from('2\r\nhi\r\n0\r\n\r\nHTTP')).toString('utf8')).toBe('hi')
    expect(dec.complete).toBe(true)
    expect(dec.excess).toBe(4)
    dec.push(Buffer.from('/1.1'))
    expect(dec.excess).toBe(8)
  })

  it('never calls a message with a malformed size line complete', () => {
    const dec = new ChunkedDecoder()
    dec.push(Buffer.from('zz\r\n\r\n\r\n'))
    expect(dec.finished).toBe(true)
    expect(dec.complete).toBe(false)
  })

  it('returns empty buffer when no complete chunk is available yet', () => {
    const dec = new ChunkedDecoder()
    expect(dec.push(Buffer.from('5\r\nhel')).toString('utf8')).toBe('hel')
    expect(dec.push(Buffer.from('lo\r\n0\r\n\r\n')).toString('utf8')).toBe('lo')
  })
})
