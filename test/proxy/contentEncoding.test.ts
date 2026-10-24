import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import { decodeContentEncoding, UnsupportedEncoding } from '../../src/proxy/contentEncoding.js'

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
