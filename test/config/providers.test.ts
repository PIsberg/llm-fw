import { describe, it, expect } from 'vitest'
import {
  identifyService,
  AI_PROVIDERS,
  AI_PROVIDER_HOSTS,
  AI_PROVIDER_DOMAINS,
} from '../../src/config/providers.js'

describe('provider registry invariants', () => {
  it('exposes a non-empty, de-duplicated host list', () => {
    expect(AI_PROVIDER_HOSTS.length).toBeGreaterThan(0)
    expect(new Set(AI_PROVIDER_HOSTS).size).toBe(AI_PROVIDER_HOSTS.length)
  })

  it('exposes a de-duplicated domain list', () => {
    expect(new Set(AI_PROVIDER_DOMAINS).size).toBe(AI_PROVIDER_DOMAINS.length)
  })

  it('labels every sinkholed host as a known provider (never Custom)', () => {
    // A host the sinkhole redirects must be identifiable on the dashboard,
    // otherwise blocked traffic would show up as "Custom".
    for (const host of AI_PROVIDER_HOSTS) {
      expect(identifyService(host), host).not.toBe('Custom')
    }
  })

  it('derives hosts from the registry exactly', () => {
    const expected = new Set(AI_PROVIDERS.flatMap(p => p.hosts))
    expect(new Set(AI_PROVIDER_HOSTS)).toEqual(expected)
  })
})

describe('identifyService', () => {
  it('maps concrete API hosts to their provider', () => {
    expect(identifyService('api.anthropic.com')).toBe('Anthropic')
    expect(identifyService('api.openai.com')).toBe('OpenAI')
    expect(identifyService('generativelanguage.googleapis.com')).toBe('Google')
    expect(identifyService('aiplatform.googleapis.com')).toBe('Google')
  })

  it('matches regional/tenant subdomains via the domain suffix', () => {
    expect(identifyService('my-resource.openai.azure.com')).toBe('OpenAI')
    expect(identifyService('foo.googleapis.com')).toBe('Google')
  })

  it('labels infrastructure hosts', () => {
    expect(identifyService('github.com')).toBe('GitHub')
    expect(identifyService('registry.npmjs.org')).toBe('NPM')
    expect(identifyService('login.microsoft.com')).toBe('Microsoft')
  })

  it('does not match a lookalike domain (suffix boundary is enforced)', () => {
    // endsWith('.anthropic.com') must not be satisfied by "evil-anthropic.com".
    expect(identifyService('evil-anthropic.com')).toBe('Custom')
    expect(identifyService('notopenai.com')).toBe('Custom')
  })

  it('classifies loopback and private ranges as Local', () => {
    expect(identifyService('localhost')).toBe('Local')
    expect(identifyService('127.0.0.1')).toBe('Local')
    expect(identifyService('10.0.0.1')).toBe('Local')
    expect(identifyService('192.168.1.5')).toBe('Local')
    expect(identifyService('172.16.0.1')).toBe('Local')
    expect(identifyService('172.31.255.255')).toBe('Local')
  })

  it('does not treat 172.x outside 16-31 as private', () => {
    expect(identifyService('172.15.0.1')).toBe('Custom')
    expect(identifyService('172.32.0.1')).toBe('Custom')
  })

  it('falls back to Custom for unknown hosts', () => {
    expect(identifyService('example.com')).toBe('Custom')
  })
})
