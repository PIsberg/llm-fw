import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { decodeCaesarCandidates } from '../../src/detection/normalize.js'

// The Caesar decoder rebuilt the whole text once per shift (25 times) with a
// callback per character, only to test 7 keywords: 2.3 s of a 13 s scan of one
// 2.5 MB text, all of it blocking the event loop (#464). The faster form must
// return exactly what the original returned. This is the original, verbatim.
function referenceCaesar(text: string): { text: string; source: string }[] {
  const results: { text: string; source: string }[] = []
  const keywords = ['ignore', 'system', 'prompt', 'rules', 'forget', 'override', 'instruction']
  for (let shift = 1; shift < 26; shift++) {
    const shifted = text.replace(/[a-zA-Z]/g, (c) => {
      const base = c <= 'Z' ? 65 : 97
      return String.fromCharCode(((c.charCodeAt(0) - base + shift) % 26) + base)
    })
    const normalized = shifted.toLowerCase()
    if (keywords.some(kw => normalized.includes(kw))) {
      results.push({ text: shifted, source: 'caesar' })
    }
  }
  return results
}

const shiftBy = (s: string, k: number) => s.replace(/[a-z]/g, c => String.fromCharCode(((c.charCodeAt(0) - 97 + k) % 26) + 97))
const KEYWORD = fc.constantFrom('ignore', 'system', 'prompt', 'rules', 'forget', 'override', 'instruction')

describe('decodeCaesarCandidates returns exactly what the original did', () => {
  it('on text carrying a shifted keyword, in either case', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), KEYWORD, fc.integer({ min: 1, max: 25 }), fc.boolean(), fc.string({ maxLength: 40 }), (pre, kw, k, upper, post) => {
        const enc = shiftBy(kw, 26 - k)
        const text = `${pre} ${upper ? enc.toUpperCase() : enc} ${post}`
        expect(decodeCaesarCandidates(text)).toEqual(referenceCaesar(text))
      }),
      { numRuns: 400 },
    )
  })

  it('on arbitrary text, including the characters that lowercase into ASCII from outside it', () => {
    // U+0130 lowercases to "i" plus a combining dot and U+212A (Kelvin) to "k":
    // the one place checking the lowercased text could disagree with
    // lowercasing the shifted text.
    const unit = fc.oneof(
      fc.string({ maxLength: 6 }),
      fc.constantFrom('İ', 'K', 'gnore', 'ystem', 'ules', 'orget', 'nstruction', 'K', 'I'),
      KEYWORD.map(kw => shiftBy(kw, 3)),
    )
    fc.assert(
      fc.property(fc.array(unit, { maxLength: 12 }).map(a => a.join('')), (text) => {
        expect(decodeCaesarCandidates(text)).toEqual(referenceCaesar(text))
      }),
      { numRuns: 600 },
    )
  })

  it('on keywords written next to U+0130 and U+212A', () => {
    for (const text of ['İ' + shiftBy('gnore', 23), shiftBy('rules', 5) + 'K', 'K' + shiftBy('instruction', 11) + 'İ']) {
      expect(decodeCaesarCandidates(text)).toEqual(referenceCaesar(text))
    }
  })
})
