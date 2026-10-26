import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ayaSample } from '../../scripts/fetch-eval-data.js'

// The Aya dataset is the human-written benign traffic for the per-language
// override lexicons: the oasst1 sample's non-English turns are mostly
// languages that had hand-written rules already. Its sample must stay held
// out, so it is drawn only from the half of the dataset whose sha256 is odd;
// the even half was the one searched for false positives while the lexicons
// were written.

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const odd = (s: string): boolean => parseInt(sha(s).slice(-1), 16) % 2 === 1

// Deterministic prompts, enough that both halves have several per language.
const prompts = (lang: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ inputs: `${lang} prompt number ${i}`, language_code: lang }))

describe('ayaSample', () => {
  it('draws only from the odd-sha256 half', () => {
    const rows = ayaSample(prompts('swe', 60), 100)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => odd(r.text))).toBe(true)
    expect(rows).toHaveLength(prompts('swe', 60).filter(p => odd(p.inputs)).length)
  })

  it('takes at most perLanguage rows per language, the lowest sha256 first', () => {
    const rows = ayaSample([...prompts('hin', 60), ...prompts('dan', 60)], 3)
    for (const lang of ['hin', 'dan']) {
      const got = rows.filter(r => r.class === lang).map(r => r.text)
      const expected = prompts(lang, 60).map(p => p.inputs).filter(odd).sort((a, b) => sha(a).localeCompare(sha(b))).slice(0, 3)
      expect(got).toEqual(expected)
    }
  })

  it('drops empty text and rows without a language, and de-duplicates', () => {
    const dup = prompts('tur', 40).find(p => odd(p.inputs))!
    const rows = ayaSample([{ inputs: '   ', language_code: 'tur' }, { inputs: dup.inputs, language_code: null }, dup, dup], 10)
    expect(rows).toEqual([{ text: dup.inputs, label: 0, class: 'tur' }])
  })
})

describe('test/eval/data/aya-sample.json', () => {
  const file = JSON.parse(readFileSync(
    fileURLToPath(new URL('./data/aya-sample.json', import.meta.url)), 'utf8',
  )) as { _revision: string; _license?: string; rows: { text: string; label: number; class?: string }[] }

  it('is a pinned benign sample of at most 40 prompts per language, from the held-out half', () => {
    expect(file._revision).toMatch(/^[0-9a-f]{40}$/)
    expect(file.rows.every(r => r.label === 0)).toBe(true)
    expect(file.rows.every(r => odd(r.text))).toBe(true)
    const perLang = new Map<string, number>()
    for (const r of file.rows) perLang.set(r.class ?? '', (perLang.get(r.class ?? '') ?? 0) + 1)
    expect(Math.max(...perLang.values())).toBeLessThanOrEqual(40)
    // The lexicon languages the corpus is for are present.
    for (const lang of ['hin', 'ben', 'tur', 'vie', 'pol', 'swe', 'tha', 'pes', 'ind', 'tam']) expect(perLang.get(lang), lang).toBeGreaterThan(0)
  })

  it('carries the Apache 2.0 attribution', () => {
    expect(file._license).toMatch(/Apache/)
    expect(file._license).toMatch(/aya_dataset/)
  })
})
