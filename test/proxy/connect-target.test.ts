import { describe, it, expect } from 'vitest'
import { parseConnectTarget } from '../../src/proxy/proxy.js'

describe('parseConnectTarget', () => {
  it('parses host:port', () => {
    expect(parseConnectTarget('api.anthropic.com:443')).toEqual({
      hostname: 'api.anthropic.com',
      port: 443,
    })
  })

  it('parses a non-default port', () => {
    expect(parseConnectTarget('example.com:8443')).toEqual({
      hostname: 'example.com',
      port: 8443,
    })
  })

  it('does NOT truncate the hostname when no port is supplied', () => {
    // Regression: lastIndexOf(':') returned -1 and slice(0, -1) produced
    // "api.anthropic.co" — misrouting the request.
    expect(parseConnectTarget('api.anthropic.com')).toEqual({
      hostname: 'api.anthropic.com',
      port: 443,
    })
  })

  it('falls back to 443 for a lone trailing colon', () => {
    expect(parseConnectTarget('api.anthropic.com:')).toEqual({
      hostname: 'api.anthropic.com',
      port: 443,
    })
  })

  it('falls back to 443 for a non-numeric port', () => {
    expect(parseConnectTarget('example.com:abc')).toEqual({
      hostname: 'example.com',
      port: 443,
    })
  })
})
