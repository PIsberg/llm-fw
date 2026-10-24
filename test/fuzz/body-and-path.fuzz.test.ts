import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { duplicateKey } from '../../src/detection/jsonStrict.js'
import { canonicalPath } from '../../src/detection/canonicalPath.js'
import { getParser, AnthropicParser } from '../../src/detection/parsers.js'

// Properties for the two checks that decide whether a request is read the way
// the provider will read it: duplicateKey (a repeated key is refused, since
// JSON.parse keeps the last and a provider may keep the first) and
// canonicalPath (the path a parser is matched on). Both must agree with what
// they model, not just avoid throwing.
const NUM_RUNS = 300

describe('duplicateKey agrees with the JSON it reads', () => {
  it('finds nothing in anything JSON.stringify produced', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(duplicateKey(JSON.stringify(v))).toBeNull()
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('finds a key repeated at the top level, however it is spelled', () => {
    const objectWithKey = fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue({ maxDepth: 2 }), { minKeys: 1, maxKeys: 6 })
    fc.assert(
      fc.property(objectWithKey, fc.boolean(), (obj, escapeIt) => {
        const key = Object.keys(obj)[0]!
        // The same key, written either as JSON.stringify writes it or with
        // every character as a \u escape: both name the same key once parsed.
        const spelled = escapeIt
          ? '"' + [...key].map(c => c.split('').map(u => '\\u' + u.charCodeAt(0).toString(16).padStart(4, '0')).join('')).join('') + '"'
          : JSON.stringify(key)
        // A replacer function: a key such as "$$" is a pattern in a replacement string.
        const body = JSON.stringify(obj).replace(/\}$/, () => `,${spelled}:1}`)
        expect(JSON.parse(body)[key]).toBe(1) // valid JSON, last one wins
        expect(duplicateKey(body)).toBe(key)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})

describe('canonicalPath', () => {
  const pathish = fc.array(
    fc.oneof(fc.constantFrom('', '.', '..', 'v1', 'messages', '%6D', '%2F', ';x=1', 'a%zz'), fc.webSegment()),
    { maxLength: 8 },
  ).map(segments => '/' + segments.join('/'))

  it('is idempotent, absolute and free of empty or dot segments', () => {
    fc.assert(
      fc.property(fc.oneof(pathish, fc.string({ maxLength: 60 })), (p) => {
        const c = canonicalPath(p)
        expect(c.startsWith('/')).toBe(true)
        expect(c.includes('//')).toBe(false)
        expect(c.split('/').slice(1).some(s => s === '.' || s === '..')).toBe(false)
        // Idempotent unless decoding exposed something a second pass reads
        // differently: a new escape (%2536 -> %36 -> 6), or an encoded ? or #
        // (%3F -> ?), which the first pass keeps as path text and a second
        // pass would take for a query or fragment. The matcher only ever
        // runs one pass. Found by CI on seed 869839893 with input "%3F".
        if (!/%[0-9a-fA-F]{2}|[?#]/.test(c)) expect(canonicalPath(c)).toBe(c)
      }),
      { numRuns: NUM_RUNS },
    )
  })

  it('keeps an encoded ? or # as path text, which can only widen a parser match', () => {
    expect(canonicalPath('%3F')).toBe('/?')
    expect(canonicalPath('/v1/messages%3Fx')).toBe('/v1/messages?x')
    // The parsers split on "?" themselves, so this is read as the Messages
    // API: scanned rather than passed, the safe side of the ambiguity.
    expect(getParser('/v1/messages%3Fx')).toBeInstanceOf(AnthropicParser)
  })

  it('reads any spelling that resolves to /v1/messages as the Messages API', () => {
    const noise = fc.array(fc.constantFrom('', '.', 'x/..', ';p=1'), { maxLength: 3 }).map(a => a.join('/'))
    fc.assert(
      fc.property(noise, noise, fc.boolean(), (a, b, encode) => {
        const messages = encode ? '%6D%65ssages' : 'messages'
        const path = `/${a}/v1/${b}/${messages}/`.replace(/\/{2,}/g, m => m) // keep doubled slashes
        expect(getParser(path)).toBeInstanceOf(AnthropicParser)
      }),
      { numRuns: NUM_RUNS },
    )
  })
})
