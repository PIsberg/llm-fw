import { describe, it, expect } from 'vitest'
import { duplicateKey } from '../../src/detection/jsonStrict.js'

// JSON.parse keeps the LAST value of a repeated key. A provider whose parser
// keeps the first would act on text the pipeline never scanned, so a body
// with a repeated key is refused rather than guessed at.
describe('duplicateKey', () => {
  it('finds nothing in an ordinary request body', () => {
    const body = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'a "quoted" {brace} and [bracket] in a string' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ],
      metadata: { user_id: 'x', nested: { a: 1, b: [1, 2, { a: 3 }] } },
    })
    expect(duplicateKey(body)).toBeNull()
  })

  it('names a repeated top-level key', () => {
    expect(duplicateKey('{"messages":[{"role":"user","content":"hi"}],"messages":[]}')).toBe('messages')
  })

  it('names a repeated key inside an array element', () => {
    expect(duplicateKey('{"messages":[{"role":"user","content":"benign","content":"attack"}]}')).toBe('content')
  })

  it('treats an escaped spelling of a key as the same key', () => {
    expect(duplicateKey('{"content":"benign","\\u0063ontent":"attack"}')).toBe('content')
  })

  it('allows the same key in sibling objects', () => {
    expect(duplicateKey('[{"a":1},{"a":2},{"b":{"a":3}}]')).toBeNull()
  })

  it('is not confused by keys that look alike or by escaped quotes', () => {
    expect(duplicateKey('{"a\\"b":1,"a":2,"b":"\\"a\\":3"}')).toBeNull()
  })

  it('reads a multi-megabyte body in linear time', () => {
    const messages = Array.from({ length: 20_000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} `.repeat(30) }))
    const body = JSON.stringify({ model: 'm', messages })
    expect(body.length).toBeGreaterThan(5_000_000)
    const t0 = performance.now()
    expect(duplicateKey(body)).toBeNull()
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})
