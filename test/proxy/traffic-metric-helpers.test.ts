import { describe, it, expect } from 'vitest'
import { normalizeIp, sanitizeHeaders } from '../../src/proxy/proxy.js'

describe('normalizeIp', () => {
  it('strips the IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIp('::ffff:192.168.1.10')).toBe('192.168.1.10')
  })

  it('passes a plain IPv4 address through unchanged', () => {
    expect(normalizeIp('10.0.0.5')).toBe('10.0.0.5')
  })

  it('passes a plain IPv6 address through unchanged', () => {
    expect(normalizeIp('::1')).toBe('::1')
  })

  it('returns "unknown" for undefined or empty input', () => {
    expect(normalizeIp(undefined)).toBe('unknown')
    expect(normalizeIp('')).toBe('unknown')
  })
})

describe('sanitizeHeaders', () => {
  it('redacts credential-bearing headers but keeps the header name', () => {
    const out = sanitizeHeaders({
      'content-type': 'application/json',
      authorization: 'Bearer sk-secret-123',
      'x-api-key': 'abcdef',
      'x-goog-api-key': 'goog-secret',
      cookie: 'session=deadbeef',
    })
    expect(out['content-type']).toBe('application/json')
    expect(out.authorization).toBe('«redacted»')
    expect(out['x-api-key']).toBe('«redacted»')
    expect(out['x-goog-api-key']).toBe('«redacted»')
    expect(out.cookie).toBe('«redacted»')
  })

  it('is case-insensitive when matching sensitive header names', () => {
    const out = sanitizeHeaders({ Authorization: 'Bearer x', 'X-API-KEY': 'y' })
    expect(out.Authorization).toBe('«redacted»')
    expect(out['X-API-KEY']).toBe('«redacted»')
  })

  it('joins array-valued headers', () => {
    const out = sanitizeHeaders({ 'accept-language': ['en', 'sv'] })
    expect(out['accept-language']).toBe('en, sv')
  })

  it('skips undefined header values', () => {
    const out = sanitizeHeaders({ 'content-type': 'text/plain', 'x-missing': undefined })
    expect(out).not.toHaveProperty('x-missing')
    expect(out['content-type']).toBe('text/plain')
  })
})
