import { describe, it, expect } from 'vitest'
import { UrlClassifier, normalizeDomainEntry, isAuthPath } from '../../src/detection/urlHeuristic.js'
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

describe('normalizeDomainEntry', () => {
  it('strips scheme, path, port, wildcard, dot and whitespace', () => {
    expect(normalizeDomainEntry('https://webhook.site')).toBe('webhook.site')
    expect(normalizeDomainEntry('webhook.site/')).toBe('webhook.site')
    expect(normalizeDomainEntry('http://example.com/path?x=1')).toBe('example.com')
    expect(normalizeDomainEntry('example.com:443')).toBe('example.com')
    expect(normalizeDomainEntry('*.example.com')).toBe('example.com')
    expect(normalizeDomainEntry('.example.com')).toBe('example.com')
    expect(normalizeDomainEntry('  WebHook.Site  ')).toBe('webhook.site')
  })
  it('drops userinfo and keeps bracketed IPv6 literals', () => {
    expect(normalizeDomainEntry('user:pass@example.com')).toBe('example.com')
    expect(normalizeDomainEntry('[2001:db8::1]:8443')).toBe('2001:db8::1')
    expect(normalizeDomainEntry('[::1]')).toBe('::1')
  })
  it('returns empty string for blank/whitespace-only entries', () => {
    expect(normalizeDomainEntry('   ')).toBe('')
    expect(normalizeDomainEntry('')).toBe('')
  })
})

describe('UrlClassifier — decorated allowlist entries still match', () => {
  // Regression: operators paste full URLs / ports / wildcards into the allowlist;
  // these must whitelist the bare host instead of silently leaving it blocked.
  it('full-URL allowlist entry whitelists a known-exfil host', () => {
    const u = new UrlClassifier({ enabled: true, entropyThreshold: 4.8, allowlistDomains: ['https://webhook.site/'], blocklistDomains: [] })
    expect(u.classify('webhook.site').action).toBe('pass')
  })
  it('wildcard allowlist entry whitelists subdomains', () => {
    const u = new UrlClassifier({ enabled: true, entropyThreshold: 4.8, allowlistDomains: ['*.example.com'], blocklistDomains: [] })
    expect(u.classify('api.example.com').action).toBe('pass')
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
    expect(r.reason).toMatch('high-entropy-host')
  })
  it('blocks a bare high-entropy DGA apex (no subdomain)', () => {
    // The random string IS the registrable label — previously slipped through
    // because only subdomains were entropy-screened.
    const dga = 'zQ7mK2pX9vN4wL8tG5bY1jH6rC3sF0aD'
    const r = c.classify(`${dga}.com`)
    expect(r.action).toBe('block')
    expect(r.reason).toMatch('high-entropy-host')
  })
  it('blocks a DGA apex reached via response-exfil path screening', () => {
    // ![](https://<dga>.net/) markdown-image destinations resolve through the
    // same classifier the response-exfil scanner uses.
    const dga = 'x7Kq9Zw2Pm4Lt8Gb5Yj1Hr6Cs3Fa0D'
    expect(c.classify(`${dga}.net`).action).toBe('block')
  })
  // #335: the playground's own "Random/DGA host" example passed. Shannon
  // entropy of an n-character label cannot exceed log2(n), so the 4.8 gate is
  // unreachable below ~28 characters; x7f9q2k8z1p3v6w4 (16 distinct) is 4.0.
  // The registrable label is now also screened for interleaved
  // letters and digits with almost no vowels.
  it('blocks a realistic 16-character DGA apex', () => {
    const r = c.classify('x7f9q2k8z1p3v6w4.com')
    expect(r.action).toBe('block')
    expect(r.reason).toMatch('dga-label')
  })
  it('blocks other interleaved random apexes', () => {
    for (const h of ['g874v3fpi3s1.com', 'mg8sh1npdm3b.com', 'uh9f87a4jqgrvq3p.info']) {
      expect(c.classify(h).action, h).toBe('block')
    }
  })
  it('passes real brands that mix letters and digits', () => {
    for (const h of ['1password.com', '123movies.to', 'web3auth.io', 'x10hosting.com', 'm365copilot.com', 'studio3t.com', 'win10tweaker.ru', 'covid19vaccine.gov', 'ex2018edition.net']) {
      expect(c.classify(h).action, h).toBe('pass')
    }
  })
  it('does not screen CDN subdomain hashes this way (only the registrable label)', () => {
    expect(c.classify('d2c8v52ll5s99u.cloudfront.net').action).toBe('pass')
    expect(c.classify('a1b2c3d4e5f6g7h8.s3.amazonaws.com').action).toBe('pass')
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

describe('UrlClassifier — classifyPath (host-independent path screening)', () => {
  it('blocks a long base64 value in the path regardless of host allowlisting', () => {
    const long = 'A'.repeat(65)
    const r = c.classifyPath(`/v1/messages?payload=${long}`)
    expect(r.action).toBe('block')
    expect(r.reason).toBe('query-exfil-pattern')
  })
  it('blocks suspicious exfil parameter names', () => {
    expect(c.classifyPath('/upload?exfil=secret').action).toBe('block')
    expect(c.classifyPath('/x?data=foo').action).toBe('block')
  })
  it('passes an ordinary path/query', () => {
    expect(c.classifyPath('/v1/messages').action).toBe('pass')
    expect(c.classifyPath('/api/v1/users?limit=50&page=2').action).toBe('pass')
  })
  it('exempts OAuth and login paths with tokens, codes, and state parameters', () => {
    const longCode = 'A'.repeat(80)
    expect(c.classifyPath('/oauth/authorize?token=secret123').action).toBe('pass')
    expect(c.classifyPath(`/oauth/callback?code=${longCode}&state=xyz`).action).toBe('pass')
    expect(c.classifyPath(`/cai/oauth/authorize?code_challenge=${longCode}`).action).toBe('pass')
    expect(c.classifyPath('/api/oauth/profile?token=abc').action).toBe('pass')
    expect(c.classifyPath('/api/oauth/claude_cli/create_api_key').action).toBe('pass')
    expect(c.classifyPath('/api/claude_cli_profile').action).toBe('pass')
    expect(c.classifyPath('/v1/oauth/token').action).toBe('pass')
    expect(c.classifyPath('/login?token=abc').action).toBe('pass')
    expect(c.classifyPath('/callback?token=abc').action).toBe('pass')
  })
  it('still blocks exfiltration query parameters on non-auth paths', () => {
    expect(c.classifyPath('/v1/messages?token=secret123').action).toBe('block')
    expect(c.classifyPath('/v1/chat/completions?secret=foo').action).toBe('block')
    expect(c.classifyPath('/api/v1/data?token=abc').action).toBe('block')
  })
})

describe('isAuthPath', () => {
  it('recognizes standard OAuth, login and CLI management paths', () => {
    expect(isAuthPath('/oauth/authorize')).toBe(true)
    expect(isAuthPath('/oauth2/v2.0/token')).toBe(true)
    expect(isAuthPath('/cai/oauth/authorize')).toBe(true)
    expect(isAuthPath('/api/oauth/profile')).toBe(true)
    expect(isAuthPath('/v1/oauth/token')).toBe(true)
    expect(isAuthPath('/api/claude_cli/roles')).toBe(true)
    expect(isAuthPath('/login')).toBe(true)
    expect(isAuthPath('/callback')).toBe(true)
    expect(isAuthPath('/.well-known/openid-configuration')).toBe(true)
  })

  it('rejects ordinary and model endpoints', () => {
    expect(isAuthPath('/v1/messages')).toBe(false)
    expect(isAuthPath('/v1/chat/completions')).toBe(false)
    expect(isAuthPath('/upload')).toBe(false)
    expect(isAuthPath('/')).toBe(false)
  })
})

describe('UrlClassifier — clean domains', () => {
  it('passes common trusted domains', () => {
    expect(c.classify('github.com').action).toBe('pass')
    expect(c.classify('google.com').action).toBe('pass')
    expect(c.classify('npmjs.org').action).toBe('pass')
  })
})
