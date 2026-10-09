import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { stratifiedSample, DOLLY_FULL_FILE } from '../../scripts/fetch-eval-data.js'

// The Dolly-15k sample is a held-out benign corpus for the false-positive gate
// (#245). Two properties make it a measurement rather than a claim: the sample
// is reproducible from the pinned revision, and it does not contain the rows
// that fixes were written against.

describe('stratifiedSample', () => {
  const rows = [
    ...Array.from({ length: 60 }, (_, i) => ({ text: `a${i}`, class: 'a' })),
    ...Array.from({ length: 30 }, (_, i) => ({ text: `b${i}`, class: 'b' })),
    ...Array.from({ length: 10 }, (_, i) => ({ text: `c${i}`, class: 'c' })),
  ]

  it('returns exactly n rows, split in proportion to class size', () => {
    const s = stratifiedSample(rows, 10)
    expect(s).toHaveLength(10)
    const count = (k: string) => s.filter(r => r.class === k).length
    expect([count('a'), count('b'), count('c')]).toEqual([6, 3, 1])
  })

  it('hands remainders to the largest fractional quotas, and still sums to n', () => {
    // 60/30/10 of 7 = 4.2 / 2.1 / 0.7: floors give 6, one remainder goes to c.
    const s = stratifiedSample(rows, 7)
    expect(s).toHaveLength(7)
    expect(s.filter(r => r.class === 'c')).toHaveLength(1)
  })

  it('is deterministic and independent of input order', () => {
    const a = stratifiedSample(rows, 10).map(r => r.text)
    const b = stratifiedSample([...rows].reverse(), 10).map(r => r.text)
    expect(b).toEqual(a)
  })
})

describe('test/eval/data/dolly-15k-sample.json', () => {
  const file = JSON.parse(readFileSync(
    fileURLToPath(new URL('./data/dolly-15k-sample.json', import.meta.url)), 'utf8',
  )) as { _revision: string; _license?: string; _threat: string; rows: { text: string; label: number; class?: string }[] }

  it('is the pinned 2000-row benign sample across every Dolly category', () => {
    expect(file._revision).toMatch(/^[0-9a-f]{40}$/)
    expect(file.rows).toHaveLength(2000)
    expect(file.rows.every(r => r.label === 0)).toBe(true)
    expect(new Set(file.rows.map(r => r.class))).toEqual(new Set([
      'brainstorming', 'classification', 'closed_qa', 'creative_writing',
      'general_qa', 'information_extraction', 'open_qa', 'summarization',
    ]))
  })

  it('carries the CC BY-SA 3.0 attribution the licence requires', () => {
    expect(file._license).toMatch(/CC BY-SA 3\.0/)
    expect(file._license).toMatch(/Databricks/)
  })

  it('excludes the survey rows that fixes were written against', () => {
    const texts = new Set(file.rows.map(r => r.text))
    for (const t of [
      'List the names of several laundry detergent brands',
      'Give me Personal finance advice',
      'Give me a bulleted list of first person shooter games on PS4',
      'Which institute is known as International money laundering watch dog?',
    ]) expect(texts.has(t)).toBe(false)
  })
})

describe('the full Dolly-15k set (#256)', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))

  it('is written under test/eval/data/, to a path git ignores', () => {
    // 15,011 rows fetched fresh by the nightly job. Committed, it would be a
    // second copy of the dataset to keep licensed and in sync, and a tempting
    // corpus to tune against.
    const rel = relative(root, DOLLY_FULL_FILE).replace(/\\/g, '/')
    expect(rel).toMatch(/^test\/eval\/data\//)
    // `git check-ignore` exits 0 when the path is ignored, 1 when it is not.
    expect(() => execFileSync('git', ['check-ignore', '-q', rel], { cwd: root })).not.toThrow()
  })
})
