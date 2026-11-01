import { describe, it, expect } from 'vitest'
import { isInterceptedHost, parserForRequest } from '../../src/proxy/proxy.js'
import { isTokenCountRequest } from '../../src/proxy/tokenCount.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { AI_PROVIDER_HOSTS, identifyService } from '../../src/config/providers.js'

// #594: on 2026-10-31 the traffic log showed Antigravity's Gemini turns going
// to daily-cloudcode-pa.googleapis.com, tunnelled uninspected because the host
// was in no list. Gemini CLI and Gemini Code Assist use cloudcode-pa itself.

const HOSTS = ['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com']

describe('Cloud Code hosts', () => {
  it.each(HOSTS)('%s is a default target, so the proxy intercepts it and the sinkhole redirects it', host => {
    expect(AI_PROVIDER_HOSTS).toContain(host)
    expect(DEFAULT_CONFIG.targets).toContain(host)
    expect(isInterceptedHost(host, DEFAULT_CONFIG)).toBe(true)
    expect(identifyService(host)).toBe('Google')
  })

  it('does not widen interception to the rest of googleapis.com', () => {
    expect(isInterceptedHost('oauth2.googleapis.com', DEFAULT_CONFIG)).toBe(false)
    expect(isInterceptedHost('play.googleapis.com', DEFAULT_CONFIG)).toBe(false)
    expect(isInterceptedHost('evil-cloudcode-pa.googleapis.com', DEFAULT_CONFIG)).toBe(false)
  })

  it('parses the generate paths on those hosts', () => {
    expect(parserForRequest('daily-cloudcode-pa.googleapis.com', '/v1internal:streamGenerateContent?alt=sse', DEFAULT_CONFIG)).not.toBeNull()
    expect(parserForRequest('cloudcode-pa.googleapis.com', '/v1internal:generateContent', DEFAULT_CONFIG)).not.toBeNull()
  })

  // The count carries the same conversation, so DLP scans it (GHSA-9986).
  it('treats the Cloud Code token count as a token-counting request', () => {
    expect(isTokenCountRequest('/v1internal:countTokens')).toBe(true)
    expect(isTokenCountRequest('/v1internal:loadCodeAssist')).toBe(false)
  })
})
