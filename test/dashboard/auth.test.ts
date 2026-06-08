import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isLoopbackAddr, presentedToken, tokenMatches } from '../../src/dashboard/server.js'

const reqWith = (headers: Record<string, string>): IncomingMessage =>
  ({ headers } as unknown as IncomingMessage)
const urlWith = (query = '') => new URL('http://localhost:7731/api/settings' + query)

describe('isLoopbackAddr', () => {
  it('recognizes loopback addresses (incl. IPv4-mapped IPv6)', () => {
    expect(isLoopbackAddr('127.0.0.1')).toBe(true)
    expect(isLoopbackAddr('::1')).toBe(true)
    expect(isLoopbackAddr('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddr('127.5.6.7')).toBe(true)
  })
  it('treats LAN / public addresses as non-loopback', () => {
    expect(isLoopbackAddr('192.168.1.20')).toBe(false)
    expect(isLoopbackAddr('10.0.0.5')).toBe(false)
    expect(isLoopbackAddr('203.0.113.9')).toBe(false)
    expect(isLoopbackAddr(undefined)).toBe(false)
  })
})

describe('presentedToken', () => {
  it('reads a Bearer token', () => {
    expect(presentedToken(reqWith({ authorization: 'Bearer abc123' }), urlWith())).toBe('abc123')
  })
  it('reads the password half of Basic auth', () => {
    const basic = 'Basic ' + Buffer.from('admin:s3cret').toString('base64')
    expect(presentedToken(reqWith({ authorization: basic }), urlWith())).toBe('s3cret')
  })
  it('falls back to a ?token= query param', () => {
    expect(presentedToken(reqWith({}), urlWith('?token=qtok'))).toBe('qtok')
  })
  it('returns empty when nothing is presented', () => {
    expect(presentedToken(reqWith({}), urlWith())).toBe('')
  })
})

describe('tokenMatches', () => {
  it('matches identical tokens', () => {
    expect(tokenMatches('s3cret-token', 's3cret-token')).toBe(true)
  })
  it('rejects a wrong or empty token', () => {
    expect(tokenMatches('wrong', 's3cret-token')).toBe(false)
    expect(tokenMatches('', 's3cret-token')).toBe(false)
    expect(tokenMatches('s3cret-token', '')).toBe(false)
  })
  it('rejects a length mismatch without throwing', () => {
    expect(tokenMatches('short', 'a-much-longer-token')).toBe(false)
  })
})
