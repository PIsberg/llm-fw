import { describe, it, expect } from 'vitest'
import { ChunkedDecoder } from '../../../src/proxy/dechunk.js'
import { LINEAR_TIME_TIMEOUT, underMs } from '../../linearTime.js'

// #868: chunk framing parseInt accepted, and what a malformed body did next.
const decode = (raw: string) => {
  const d = new ChunkedDecoder()
  const out = d.push(Buffer.from(raw)).toString()
  return { out, complete: d.complete, finished: d.finished }
}

describe('ChunkedDecoder framing (#868)', () => {
  it.each([['-5'], ['10xyz'], ['0x5'], ['+5'], [' '], ['5 6']])('treats the size line %j as malformed, never complete', (size) => {
    const r = decode(`${size}\r\nabcde\r\n0\r\n\r\n`)
    expect(r.complete).toBe(false)
    expect(r.out).toBe('')
  })

  it('accepts a size with an extension and whitespace before it, as before', () => {
    expect(decode('5 ;ext=1\r\nabcde\r\n0\r\n\r\n')).toMatchObject({ out: 'abcde', complete: true })
  })

  it('requires the CRLF after chunk data', () => {
    const r = decode('3\r\nabcXY0\r\n\r\n')
    expect(r.complete).toBe(false)
    expect(r.out).toBe('abc')
  })

  it('stops buffering once the framing is malformed', { timeout: LINEAR_TIME_TIMEOUT }, () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61)
    expect(underMs(500, () => {
      const d = new ChunkedDecoder()
      d.push(Buffer.from('zz\r\n'))
      for (let i = 0; i < 400; i++) d.push(chunk)
      expect(d.complete).toBe(false)
    })).toBeLessThan(500)
  })
})
