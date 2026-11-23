import { describe, it, expect } from 'vitest'
import { parseResponseHead, MAX_RESPONSE_HEAD_BYTES } from '../../src/proxy/responseHead.js'

// #855: the proxy reads a provider's response head itself, off the TLS socket.
describe('parseResponseHead (#855)', () => {
  it('waits for the blank line that ends the head', () => {
    expect(parseResponseHead('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n')).toBeNull()
  })

  it('skips interim 1xx responses and reads the final one', () => {
    const raw = 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'
    const head = parseResponseHead(raw)!
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe('2')
    expect(head.headers.link).toBeUndefined()
    expect(raw.slice(head.bodyStart)).toBe('ok')
  })

  it('waits when only an interim response has arrived', () => {
    expect(parseResponseHead('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n')).toBeNull()
  })

  it('reads a header with no space after the colon, or extra space around the value', () => {
    const head = parseResponseHead('HTTP/1.1 200 OK\r\nTransfer-Encoding:chunked\r\nContent-Type:   text/event-stream  \r\n\r\n')!
    expect(head.headers['transfer-encoding']).toBe('chunked')
    expect(head.headers['content-type']).toBe('text/event-stream')
  })

  it('keeps every Set-Cookie line and joins other repeated fields', () => {
    const head = parseResponseHead('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nVary: Accept\r\nSet-Cookie: b=2\r\nVary: Origin\r\n\r\n')!
    expect(head.headers['set-cookie']).toEqual(['a=1', 'b=2'])
    expect(head.headers.vary).toBe('Accept, Origin')
  })

  it.each(['HTTP/1.1 abc OK', 'HTTP/1.1  200 OK', 'HTTP/2 200', 'garbage', ''])('refuses the status line %j', (line) => {
    expect(() => parseResponseHead(`${line}\r\nContent-Length: 0\r\n\r\n`)).toThrow(/status line/)
  })

  it('refuses a header name that is not a token', () => {
    expect(() => parseResponseHead('HTTP/1.1 200 OK\r\nBad Name: x\r\n\r\n')).toThrow(/header/)
  })

  it('refuses a head over the cap, finished or not', () => {
    const pad = `X-Pad: ${'a'.repeat(MAX_RESPONSE_HEAD_BYTES)}\r\n`
    expect(() => parseResponseHead(`HTTP/1.1 200 OK\r\n${pad}`)).toThrow(/over/)
    expect(() => parseResponseHead(`HTTP/1.1 200 OK\r\n${pad}\r\n`)).toThrow(/over/)
    const interim = 'HTTP/1.1 100 Continue\r\n\r\n'.repeat(Math.ceil(MAX_RESPONSE_HEAD_BYTES / 25) + 1)
    expect(() => parseResponseHead(interim)).toThrow(/over/)
  })
})
