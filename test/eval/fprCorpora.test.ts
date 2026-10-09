import { describe, it, expect } from 'vitest'
import { selectCorpora, corpusVerdict } from './lib/fprCorpora.js'

// `npm run fpr` gates two committed corpora on every pull request. The full
// Dolly-15k set (#256) is too slow for that and lives in a gitignored file the
// nightly job fetches, so it is opt-in and report-only: it must never join the
// PR gate by default, and when it runs it must never fail the build.

const corpora = [
  { name: 'benign-realistic' },
  { name: 'dolly-15k-sample' },
  { name: 'dolly-15k-full', optIn: true, reportOnly: true },
]

describe('selectCorpora', () => {
  it('runs every corpus except the opt-in ones by default', () => {
    expect(selectCorpora(corpora, []).map(c => c.name)).toEqual(['benign-realistic', 'dolly-15k-sample'])
  })

  it('ignores unrelated arguments', () => {
    expect(selectCorpora(corpora, ['--verbose']).map(c => c.name)).toEqual(['benign-realistic', 'dolly-15k-sample'])
  })

  it('runs exactly the corpora named by --only, opt-in ones included', () => {
    expect(selectCorpora(corpora, ['--only=dolly-15k-full']).map(c => c.name)).toEqual(['dolly-15k-full'])
    expect(selectCorpora(corpora, ['--only=dolly-15k-sample,dolly-15k-full']).map(c => c.name))
      .toEqual(['dolly-15k-sample', 'dolly-15k-full'])
  })

  it('refuses an unknown name instead of silently scanning nothing', () => {
    expect(() => selectCorpora(corpora, ['--only=dolly-15k-ful'])).toThrow(/dolly-15k-ful.*benign-realistic, dolly-15k-sample, dolly-15k-full/)
  })

  it('refuses an empty --only', () => {
    expect(() => selectCorpora(corpora, ['--only='])).toThrow(/--only/)
  })
})

describe('corpusVerdict', () => {
  const overSlo = {
    perClass: { open_qa: { n: 100, blocked: 3 } },
    blocked: 3, scanned: 100, expected: 100, sloPct: 0.5, ceilings: {},
  }

  it('fails a gated corpus that breaks its SLO', () => {
    const v = corpusVerdict({ name: 'dolly-15k-sample' }, overSlo)
    expect(v.failures.length).toBeGreaterThan(0)
    expect(v.reported).toEqual(v.failures)
  })

  it('reports, but never fails, a report-only corpus', () => {
    const v = corpusVerdict({ name: 'dolly-15k-full', reportOnly: true }, overSlo)
    expect(v.failures).toEqual([])
    // The breaches are still surfaced, so the nightly log shows them.
    expect(v.reported.length).toBeGreaterThan(0)
    expect(v.reported.join('\n')).toMatch(/open_qa/)
  })

  it('still fails a report-only corpus that scanned nothing', () => {
    // A missing or empty fetch must not look like a clean night.
    const v = corpusVerdict({ name: 'dolly-15k-full', reportOnly: true }, {
      perClass: {}, blocked: 0, scanned: 0, expected: 15011, sloPct: 0.5, ceilings: {},
    })
    expect(v.failures.join('\n')).toMatch(/NOTHING/)
  })
})
