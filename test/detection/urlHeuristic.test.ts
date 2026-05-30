import { describe, it, expect } from 'vitest'
import { UrlClassifier } from '../../src/detection/urlHeuristic.js'
import type { UrlFilterConfig } from '../../src/types.js'

const cfg: UrlFilterConfig = {
  enabled: true,
  entropyThreshold: 4.8,
  allowlistDomains: ['api.anthropic.com', 'safe.internal'],
  blocklistDomains: ['evil.com', 'attacker.net'],
}
const c = new UrlClassifier(cfg)

describe('UrlClassifier — allowlist', () => {
  it('passes exact allowlist match', () => {
    expect(c.classify('api.anthropic.com').action).toBe('pass')
  })
  it('passes subdomain of allowlisted apex', () => {
    expect(c.classify('sub.safe.internal').action).toBe('pass')
  })
  it('allowlist wins over known-exfil-domain', () => {
    const special = new UrlClassifier({ ...cfg, allowlistDomains: ['webhook.site'] })
    expect(special.classify('webhook.site').action).toBe('pass')
  })
})

describe('UrlClassifier — blocklist', () => {
  it('blocks exact user-configured domain', () => {
    expect(c.classify('evil.com').action).toBe('block')
    expect(c.classify('evil.com').reason).toBe('domain-blocklisted')
  })
  it('blocks subdomain of user-configured domain', () => {
    expect(c.classify('sub.attacker.net').action).toBe('block')
  })
})

describe('UrlClassifier — known exfil domains', () => {
  it('blocks webhook.site', () => {
    const r = c.classify('webhook.site')
    expect(r.action).toBe('block')
    expect(r.reason).toBe('known-exfil-domain')
  })
  it('blocks subdomain of webhook.site', () => {
    expect(c.classify('abc123.webhook.site').action).toBe('block')
  })
  it('blocks requestbin.com', () => {
    expect(c.classify('requestbin.com').action).toBe('block')
  })
  it('blocks ngrok tunnel domains', () => {
    expect(c.classify('abc123.ngrok.io').action).toBe('block')
    expect(c.classify('myapp.ngrok-free.app').action).toBe('block')
  })
  it('blocks burpcollaborator', () => {
    expect(c.classify('burpcollaborator.net').action).toBe('block')
  })
})

describe('UrlClassifier — subdomain entropy (DNS tunneling)', () => {
  it('blocks high-entropy subdomain >= 12 chars', () => {
    // 32 unique chars in 32-char string → entropy = log2(32) = 5.0 (> threshold 4.8)
    // mimics real DNS tunneling payload (random binary base64-encoded)
    const highEntropyLabel = 'zQ7mK2pX9vN4wL8tG5bY1jH6rC3sF0aD'
    const r = c.classify(`${highEntropyLabel}.example.com`)
    expect(r.action).toBe('block')
    expect(r.reason).toMatch('high-entropy-subdomain')
  })
  it('passes short subdomain even if high entropy', () => {
    // "xk3f" — 4 chars, below 12 minimum
    expect(c.classify('xk3f.example.com').action).toBe('pass')
  })
  it('passes low-entropy normal subdomains', () => {
    expect(c.classify('api.github.com').action).toBe('pass')
    expect(c.classify('static.cdn.example.com').action).toBe('pass')
  })
  it('blocks DNS tunnel tool label in subdomain', () => {
    expect(c.classify('iodine.attacker-infra.com').action).toBe('block')
    expect(c.classify('dnscat.evil-host.net').action).toBe('block')
  })
})

describe('UrlClassifier — query exfil patterns', () => {
  it('blocks long base64 parameter value', () => {
    const long = 'A'.repeat(65)
    expect(c.classify('example.com', `/?payload=${long}`).action).toBe('block')
  })
  it('blocks long hex parameter value', () => {
    const hex = 'a'.repeat(65)
    expect(c.classify('example.com', `/?token=${hex}`).action).toBe('block')
  })
  it('blocks suspicious parameter names', () => {
    expect(c.classify('example.com', '/?exfil=hello').action).toBe('block')
    expect(c.classify('example.com', '/?data=foo').action).toBe('block')
    expect(c.classify('example.com', '/?secret=mysecret').action).toBe('block')
  })
  it('passes ordinary query strings', () => {
    expect(c.classify('example.com', '/?q=search+term&page=2').action).toBe('pass')
    expect(c.classify('example.com', '/api/v1/users?limit=50').action).toBe('pass')
  })
})

describe('UrlClassifier — clean domains', () => {
  it('passes common trusted domains', () => {
    expect(c.classify('github.com').action).toBe('pass')
    expect(c.classify('google.com').action).toBe('pass')
    expect(c.classify('npmjs.org').action).toBe('pass')
  })
})
