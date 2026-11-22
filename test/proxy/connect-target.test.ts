import { describe, it, expect } from 'vitest'
import { parseConnectTarget, isInterceptedHost } from '../../src/proxy/proxy.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

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

  // #848: a host name is case-insensitive and may end in the root's dot, so
  // API.OPENAI.COM and api.openai.com. name the provider too. Matched raw,
  // either spelling missed every intercept domain and was tunnelled unread.
  it('lowercases the host and drops trailing root dots', () => {
    expect(parseConnectTarget('API.OpenAI.COM:443')).toEqual({ hostname: 'api.openai.com', port: 443 })
    expect(parseConnectTarget('api.anthropic.com.:443')).toEqual({ hostname: 'api.anthropic.com', port: 443 })
    expect(parseConnectTarget('Api.Anthropic.Com..')).toEqual({ hostname: 'api.anthropic.com', port: 443 })
  })
})

describe('isInterceptedHost on a host spelled another way (#848)', () => {
  it('intercepts a provider named in capitals or with a trailing dot', () => {
    for (const host of ['API.OPENAI.COM', 'api.openai.com.', 'Api.Anthropic.Com.', 'MY-RESOURCE.OPENAI.AZURE.COM.']) {
      expect(isInterceptedHost(host, DEFAULT_CONFIG), host).toBe(true)
    }
  })

  it('still tunnels a host that only ends with a provider name', () => {
    expect(isInterceptedHost('evilapi.openai.com.attacker.example.', DEFAULT_CONFIG)).toBe(false)
    expect(isInterceptedHost('notapi.anthropic.com', DEFAULT_CONFIG)).toBe(false)
  })
})
