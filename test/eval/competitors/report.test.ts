import { describe, it, expect } from 'vitest'
import { buildMarkdown, buildScatterSvg, scatterPointsForSplit, collectSkipped } from './report.js'
import type { SplitResult } from './report.js'

function fixtureSplit(overrides: Partial<SplitResult> = {}): SplitResult {
  return {
    dataset: 'heldout',
    threat: 'injection',
    n: 52,
    adapters: [
      { name: 'llm-fw cheap (default)', own: true, ran: true, n: 52, tp: 23, fn: 8, tn: 21, fp: 0, recall: 23 / 31, fpr: 0 },
      { name: 'llm-fw + classifier', own: true, ran: true, n: 52, tp: 26, fn: 5, tn: 20, fp: 1, recall: 26 / 31, fpr: 1 / 21 },
      { name: 'protectai/deberta-v3-base-prompt-injection-v2 @0.5', ran: true, n: 52, tp: 23, fn: 8, tn: 18, fp: 3, recall: 23 / 31, fpr: 3 / 21 },
      { name: 'meta-llama/Prompt-Guard-86M', ran: false, reason: 'not run: gated model (accept the Meta license at huggingface.co and set HF_TOKEN)' },
      { name: 'llama-guard-3 (ollama:llama-guard3)', ran: false, reason: 'not run: Ollama reachable but llama-guard3 is not pulled (run `ollama pull llama-guard3`)' },
      { name: 'lakera-guard (hosted API)', ran: false, reason: 'not run: LAKERA_API_KEY not set' },
    ],
    ...overrides,
  }
}

describe('collectSkipped', () => {
  it('lists every not-run adapter with its reason exactly once, even across multiple splits', () => {
    const splits = [fixtureSplit(), fixtureSplit({ dataset: 'injecagent', threat: 'indirect-injection', n: 1071 })]
    const skipped = collectSkipped(splits)
    expect(skipped).toHaveLength(3)
    expect(skipped.map(s => s.name)).toEqual([
      'meta-llama/Prompt-Guard-86M',
      'llama-guard-3 (ollama:llama-guard3)',
      'lakera-guard (hosted API)',
    ])
    expect(skipped.find(s => s.name.includes('Prompt-Guard'))?.reason).toMatch(/gated model/)
  })

  it('returns an empty array when every adapter ran', () => {
    const split = fixtureSplit({ adapters: [{ name: 'x', ran: true, n: 1, recall: 1, fpr: 0 }] })
    expect(collectSkipped([split])).toEqual([])
  })
})

describe('scatterPointsForSplit', () => {
  it('plots every adapter that ran, llm-fw presets in their own group, and no skipped adapter', () => {
    const points = scatterPointsForSplit(fixtureSplit())
    expect(points).toHaveLength(3)
    expect(points.filter(p => p.group === 'competitor').map(p => p.label)).toEqual(['protectai/deberta-v3-base-prompt-injection-v2 @0.5'])
    expect(points.filter(p => p.group === 'llm-fw').map(p => p.label)).toEqual(['llm-fw cheap (default)', 'llm-fw + classifier'])
  })

  it('excludes rows with a null FPR (attacks-only sets cannot be plotted)', () => {
    const split = fixtureSplit({
      adapters: [{ name: 'attacks-only-adapter', ran: true, n: 10, recall: 0.5, fpr: null }],
    })
    expect(scatterPointsForSplit(split)).toHaveLength(0)
  })
})

describe('buildMarkdown', () => {
  it('renders a measured row per adapter, llm-fw first and in bold, with the counts behind each rate', () => {
    const md = buildMarkdown({
      splits: [fixtureSplit()],
      generatedAt: '2026-11-09',
      ruleset: '2026.11.48',
      chartPaths: { heldout: 'competitors-results/recall-vs-fpr-heldout.svg' },
    })
    expect(md).toContain('# Competitor guardrail head-to-head')
    expect(md).toContain('Generated 2026-11-09 on ruleset 2026.11.48')
    expect(md).toContain('### heldout (injection, n=52)')
    expect(md).toContain('| **llm-fw cheap (default)** | 74.2% (23/31) | 0.0% (0/21) | ran |')
    expect(md).toContain('| **llm-fw + classifier** | 83.9% (26/31) | 4.8% (1/21) | ran |')
    expect(md).toContain('| protectai/deberta-v3-base-prompt-injection-v2 @0.5 | 74.2% (23/31) | 14.3% (3/21) | ran |')
    expect(md.indexOf('| **llm-fw cheap (default)**')).toBeLessThan(md.indexOf('| protectai/'))
    expect(md).toContain('## Adapters not run')
    expect(md).toContain('meta-llama/Prompt-Guard-86M')
    expect(md).toContain('not run: LAKERA_API_KEY not set')
    expect(md).toContain('![Recall vs FPR — heldout](competitors-results/recall-vs-fpr-heldout.svg)')
  })

  it('never presents a copied llm-fw number: every llm-fw row is one the run measured', () => {
    const md = buildMarkdown({ splits: [fixtureSplit()], generatedAt: '2026-11-09', ruleset: 'x', chartPaths: {} })
    expect(md).not.toMatch(/reference/i)
    expect(md).not.toContain('BENCHMARK-IMPROVEMENTS')
  })

  it('shows a dash, not 0%, for the rate a split has no rows for', () => {
    const attacksOnly = fixtureSplit({
      dataset: 'gandalf-ignore-instructions',
      adapters: [{ name: 'llm-fw cheap (default)', own: true, ran: true, n: 112, tp: 97, fn: 15, tn: 0, fp: 0, recall: 97 / 112, fpr: null }],
    })
    const benignOnly = fixtureSplit({
      dataset: 'oasst1-sample',
      adapters: [{ name: 'x', ran: true, n: 2000, tp: 0, fn: 0, tn: 1760, fp: 240, recall: null, fpr: 240 / 2000 }],
    })
    const md = buildMarkdown({ splits: [attacksOnly, benignOnly], generatedAt: '2026-11-09', ruleset: 'x', chartPaths: {} })
    expect(md).toContain('| **llm-fw cheap (default)** | 86.6% (97/112) | — | ran |')
    expect(md).toContain('| x | — | 12.0% (240/2000) | ran |')
  })

  it('opens with the breadcrumb every document under docs/ carries', () => {
    const md = buildMarkdown({ splits: [fixtureSplit()], generatedAt: '2026-11-09', ruleset: 'x', chartPaths: {} })
    expect(md.startsWith('[llm-fw](../README.md) > [Documentation](README.md) > Measurements > Competitor guardrail head-to-head\n')).toBe(true)
  })

  it('reports "All adapters ran." when nothing was skipped', () => {
    const split = fixtureSplit({ adapters: [{ name: 'x', ran: true, n: 1, recall: 1, fpr: 0 }] })
    const md = buildMarkdown({ splits: [split], generatedAt: '2026-07-05', ruleset: 'x', chartPaths: {} })
    expect(md).toContain('All adapters ran.')
  })

  it('omits the chart embed for a split with no chartPaths entry', () => {
    const md = buildMarkdown({ splits: [fixtureSplit()], generatedAt: '2026-07-05', ruleset: 'x', chartPaths: {} })
    expect(md).not.toContain('![Recall vs FPR')
  })
})

describe('buildScatterSvg', () => {
  it('produces a valid SVG containing every point label and the legend', () => {
    const svg = buildScatterSvg(
      [
        { label: 'llm-fw cheap (default)', recall: 0.742, fpr: 0, group: 'llm-fw' },
        { label: 'protectai-deberta @0.5', recall: 0.742, fpr: 0.143, group: 'competitor' },
      ],
      'Recall vs FPR — heldout',
    )
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
    expect(svg).toContain('Recall vs FPR — heldout')
    expect(svg).toContain('llm-fw cheap (default)')
    expect(svg).toContain('protectai-deberta @0.5')
    expect(svg).toContain('competitor')
    expect(svg).toContain('llm-fw (same run)')
  })

  it('escapes XML-special characters in labels', () => {
    const svg = buildScatterSvg([{ label: 'a < b & c', recall: 0.5, fpr: 0.1, group: 'competitor' }], 'title')
    expect(svg).not.toContain('a < b & c')
    expect(svg).toContain('a &lt; b &amp; c')
  })

  it('renders with no points and no crash (all adapters skipped)', () => {
    const svg = buildScatterSvg([], 'Recall vs FPR — empty')
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
  })
})
