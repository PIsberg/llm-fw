import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import { decodeContentEncoding, UnsupportedEncoding, MAX_ENCODINGS } from '../../src/proxy/contentEncoding.js'
import { decodeCap, MAX_DECODED_BYTES } from '../../src/proxy/bodyCap.js'

const text = JSON.stringify({ messages: [{ role: 'user', content: 'hello there' }] })
const raw = Buffer.from(text)
const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync

describe('decodeContentEncoding', () => {
  it.each([
    ['gzip', zlib.gzipSync(raw)],
    ['x-gzip', zlib.gzipSync(raw)],
    ['br', zlib.brotliCompressSync(raw)],
    ['deflate', zlib.deflateSync(raw)],
    ['deflate', zlib.deflateRawSync(raw)],
    ['GZIP', zlib.gzipSync(raw)],
    ['identity', raw],
    ['', raw],
  ])('decodes %s', (enc, body) => {
    expect(decodeContentEncoding(body, enc, 1 << 20).toString()).toBe(text)
  })

  it.runIf(zstd)('decodes zstd, the encoding Codex CLI sends', () => {
    expect(decodeContentEncoding(zstd!(raw), 'zstd', 1 << 20).toString()).toBe(text)
  })

  it('undoes stacked encodings in reverse order', () => {
    const stacked = zlib.brotliCompressSync(zlib.gzipSync(raw))
    expect(decodeContentEncoding(stacked, 'gzip, br', 1 << 20).toString()).toBe(text)
  })

  it('refuses an encoding it cannot undo', () => {
    expect(() => decodeContentEncoding(raw, 'compress', 1 << 20)).toThrow(UnsupportedEncoding)
    expect(() => decodeContentEncoding(raw, 'gzip, x-custom', 1 << 20)).toThrow(UnsupportedEncoding)
  })

  it('stops at the size cap instead of inflating a bomb', () => {
    const bomb = zlib.gzipSync(Buffer.alloc(8 << 20))
    expect(bomb.length).toBeLessThan(64 << 10)
    expect(() => decodeContentEncoding(bomb, 'gzip', 1 << 20)).toThrow(RangeError)
  })

  it('throws on a corrupt stream', () => {
    expect(() => decodeContentEncoding(Buffer.from('not gzip at all'), 'gzip', 1 << 20)).toThrow()
  })
})

// #861: with proxy.maxBodyBytes 0 (no cap) the decode limit was
// buffer.constants.MAX_LENGTH, about 4 GiB, so a 130 KB gzip bomb inflated on
// the thread serving every client until the process ran out of memory; and
// a header could stack any number of encodings, each a full pass.
describe('decode limits (#861)', () => {
  it('keeps a 128 MiB ceiling when maxBodyBytes is 0, and the configured cap otherwise', () => {
    expect(MAX_DECODED_BYTES).toBe(128 * 1024 * 1024)
    expect(decodeCap(0)).toBe(MAX_DECODED_BYTES)
    expect(decodeCap(10_485_760)).toBe(10_485_760)
  })

  it('stops a bomb at the ceiling under maxBodyBytes 0', () => {
    const bomb = zlib.gzipSync(Buffer.alloc(MAX_DECODED_BYTES + (1 << 20)), { level: 1 })
    expect(bomb.length).toBeLessThan(1 << 20)
    expect(() => decodeContentEncoding(bomb, 'gzip', decodeCap(0))).toThrow(RangeError)
  })

  it(`decodes a chain of ${3} encodings and refuses a longer one`, () => {
    expect(MAX_ENCODINGS).toBe(3)
    const wrap = (n: number) => { let b = raw; for (let i = 0; i < n; i++) b = zlib.gzipSync(b); return b }
    expect(decodeContentEncoding(wrap(3), 'gzip, gzip, gzip', 1 << 20).toString()).toBe(text)
    expect(() => decodeContentEncoding(wrap(4), 'gzip, gzip, gzip, gzip', 1 << 20)).toThrow(UnsupportedEncoding)
    // identity entries undo nothing, so they do not count.
    expect(decodeContentEncoding(wrap(3), 'gzip, identity, gzip, identity, gzip', 1 << 20).toString()).toBe(text)
  })
})
