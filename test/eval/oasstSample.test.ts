import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { oasstUserTurns, type OasstMessage } from '../../scripts/fetch-eval-data.js'

// OpenAssistant oasst1 is the conversational benign source #256 asked for:
// Dolly is single-turn instructions, and the second-person, multi-turn phrasing
// where #247 lived ("your goal for this quarter", "your role on the team") is
// barely represented there. Only what a USER typed is benign traffic for a
// request-side firewall, so assistant turns never enter the corpus.

const msg = (over: Partial<OasstMessage>): OasstMessage => ({
  text: 'How do I bake sourdough?', role: 'prompter', lang: 'en', parent_id: null,
  deleted: false, review_result: true, synthetic: false, labels: {}, ...over,
})

describe('oasstUserTurns', () => {
  it('keeps user turns and drops assistant turns', () => {
    const rows = oasstUserTurns([msg({}), msg({ role: 'assistant', text: 'Mix flour and water.' })])
    expect(rows.map(r => r.text)).toEqual(['How do I bake sourdough?'])
    expect(rows[0]!.label).toBe(0)
  })

  it('drops deleted, review-rejected and synthetic messages', () => {
    expect(oasstUserTurns([
      msg({ deleted: true }), msg({ review_result: false }), msg({ synthetic: true }),
    ])).toEqual([])
  })

  it("drops what the dataset's own reviewers labelled spam or not appropriate", () => {
    // The dataset's judgement, not the detector's: filtering on our own
    // verdicts would make the corpus agree with us by construction.
    expect(oasstUserTurns([
      msg({ labels: { spam: { value: 0.67, count: 3 } } }),
      msg({ labels: { not_appropriate: { value: 0.5, count: 2 } } }),
    ])).toEqual([])
    expect(oasstUserTurns([msg({ labels: { spam: { value: 0.33, count: 3 } } })])).toHaveLength(1)
  })

  it('drops empty text', () => {
    expect(oasstUserTurns([msg({ text: '   ' })])).toEqual([])
  })

  it('classes rows by language group and by opening turn versus follow-up', () => {
    const rows = oasstUserTurns([
      msg({ parent_id: null, lang: 'en' }),
      msg({ parent_id: 'abc', lang: 'en' }),
      msg({ parent_id: null, lang: 'es' }),
      msg({ parent_id: 'def', lang: 'ru' }),
    ])
    expect(rows.map(r => r.class)).toEqual(['en-opening', 'en-follow-up', 'other-opening', 'other-follow-up'])
  })
})

describe('test/eval/data/oasst1-sample.json', () => {
  const file = JSON.parse(readFileSync(
    fileURLToPath(new URL('./data/oasst1-sample.json', import.meta.url)), 'utf8',
  )) as { _revision: string; _license?: string; rows: { text: string; label: number; class?: string }[] }

  it('is a pinned 2000-row benign sample covering every class', () => {
    expect(file._revision).toMatch(/^[0-9a-f]{40}$/)
    expect(file.rows).toHaveLength(2000)
    expect(file.rows.every(r => r.label === 0)).toBe(true)
    expect(new Set(file.rows.map(r => r.class))).toEqual(
      new Set(['en-opening', 'en-follow-up', 'other-opening', 'other-follow-up']),
    )
  })

  it('carries the Apache 2.0 attribution', () => {
    expect(file._license).toMatch(/Apache/)
    expect(file._license).toMatch(/OpenAssistant/)
  })
})
