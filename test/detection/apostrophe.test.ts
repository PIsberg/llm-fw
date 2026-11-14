import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HeuristicScorer } from '../../src/detection/heuristic.js'
import { extractCandidates } from '../../src/detection/normalize.js'

// #795: Stage 1 never folded a typographic apostrophe, so its patterns spelled
// with an ASCII one (37 of them when #795 was filed) missed the same words typed
// with U+2019. Smart punctuation is the default on macOS and iOS keyboards and
// in word processors, so text pasted from a document carries it with no intent
// to evade.

// The modifier letter apostrophe is not folded: normalize() strips it with the
// other diacritics, and the rows below show the rules read "dont" alike.
const MARKS = ['’', '‘', 'ʼ'] as const
const hex = (mark: string) => `U+${mark.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

type Corpus = { benign: string[]; attacks: { category: string; prompt: string }[] }
const corpus = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'corpus.json'), 'utf8')) as Corpus

describe('a typographic apostrophe (#795)', () => {
  // The embedding stage reads the 'original' candidate, and its gate was
  // calibrated on text as typed. A first cut folded there too: 246 eval
  // similarities moved and one benign Dolly row crossed the gate.
  it('reaches the embedding stage as typed', () => {
    for (const mark of ['’', '‘']) {
      const candidates = extractCandidates(`Don${mark}t stop, it${mark}s fine`)
      expect(candidates[0], hex(mark)).toEqual({ text: `don${mark}t stop, it${mark}s fine`, source: 'original' })
      for (const c of candidates) expect(c.text, `${hex(mark)} ${c.source}`).not.toContain("'")
    }
  })

  // Encoded attacks are left out: an apostrophe inside an Ascii85 payload is a
  // payload character, so replacing it changes what the payload decodes to,
  // not how the request was typed.
  it('scores every corpus row typed with one exactly as with an ASCII apostrophe', () => {
    const scorer = new HeuristicScorer()
    const rows = [
      ...corpus.attacks
        .map((a, i) => ({ id: `attack ${i} (${a.category})`, text: a.prompt, encoded: a.category === 'encoding' }))
        .filter(a => !a.encoded),
      ...corpus.benign.map((text, i) => ({ id: `benign ${i}`, text })),
    ].filter(row => row.text.includes("'"))
    expect(rows.length).toBeGreaterThanOrEqual(30)
    const changed: string[] = []
    for (const row of rows) {
      const ascii = scorer.score(row.text)
      for (const mark of MARKS) {
        const typed = scorer.score(row.text.replaceAll("'", mark))
        if (typed.score !== ascii.score || typed.matches.join() !== ascii.matches.join()) {
          changed.push(`${row.id} with ${hex(mark)}: ${ascii.score} [${ascii.matches.join(' ')}] -> ${typed.score} [${typed.matches.join(' ')}]`)
        }
      }
    }
    expect(changed).toEqual([])
  })
})
