import { describe, it, expect } from 'vitest'
import { buildMarkdown, buildScatterSvg, scatterPointsForSplit, collectSkipped } from './report.js'
import type { SplitResult, ReferenceRow } from './report.js'

const references: ReferenceRow[] = [
  { preset: 'llm-fw cheap', dataset: 'heldout', n: 52, recall: 0.613, fpr: 0.095 },
  { preset: 'llm-fw classifier (judge off)', dataset: 'heldout', n: 52, recall: 0.806, fpr: 0.095 },
]

function fixtureSplit(overrides: Partial<SplitResult> = {}): SplitResult {
  return {
    dataset: 'heldout',
    threat: 'injection',
    n: 52,
    adapters: [
      { name: 'protectai/deberta-v3-base-prompt-injection-v2 @0.5', ran: true, n: 52, tp: 40, fn: 12, tn: 45, fp: 7, recall: 40 / 52, fpr: 7 / 52 },
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
  it('includes ran adapters and same-dataset references, excluding skipped adapters', () => {
    const points = scatterPointsForSplit(fixtureSplit(), references)
    expect(points).toHaveLength(3) // 1 adapter ran + 2 references
    expect(points.filter(p => p.group === 'competitor')).toHaveLength(1)
    expect(points.filter(p => p.group === 'reference')).toHaveLength(2)
  })

  it('excludes reference rows for other datasets', () => {
    const points = scatterPointsForSplit(fixtureSplit({ dataset: 'injecagent' }), references)
    expect(points.filter(p => p.group === 'reference')).toHaveLength(0)
  })

  it('excludes rows with a null FPR (attacks-only sets cannot be plotted)', () => {
    const split = fixtureSplit({
      adapters: [{ name: 'attacks-only-adapter', ran: true, n: 10, recall: 0.5, fpr: null }],
    })
    const points = scatterPointsForSplit(split, [])
    expect(points).toHaveLength(0)
  })
})

describe('buildMarkdown', () => {
  it('renders a table row per reference and per adapter, and an "adapters not run" section', () => {
    const md = buildMarkdown({
      splits: [fixtureSplit()],
      references,
      generatedAt: '2026-07-05',
      chartPaths: { heldout: 'competitors-results/recall-vs-fpr-heldout.svg' },
    })
    expect(md).toContain('# Competitor guardrail head-to-head')
    expect(md).toContain('heldout')
    expect(md).toContain('llm-fw cheap')
    expect(md).toContain('61.3%')
    expect(md).toContain('protectai/deberta-v3-base-prompt-injection-v2 @0.5')
    expect(md).toContain('76.9%') // 40/52 recall
    expect(md).toContain('## Adapters not run')
    expect(md).toContain('meta-llama/Prompt-Guard-86M')
    expect(md).toContain('not run: LAKERA_API_KEY not set')
    expect(md).toContain('![Recall vs FPR — heldout](competitors-results/recall-vs-fpr-heldout.svg)')
  })

  it('reports "All adapters ran." when nothing was skipped', () => {
    const split = fixtureSplit({ adapters: [{ name: 'x', ran: true, n: 1, recall: 1, fpr: 0 }] })
    const md = buildMarkdown({ splits: [split], references: [], generatedAt: '2026-07-05', chartPaths: {} })
    expect(md).toContain('All adapters ran.')
  })

  it('omits the chart embed for a split with no chartPaths entry', () => {
    const md = buildMarkdown({ splits: [fixtureSplit()], references, generatedAt: '2026-07-05', chartPaths: {} })
    expect(md).not.toContain('![Recall vs FPR')
  })
})

describe('buildScatterSvg', () => {
  it('produces a valid SVG containing every point label and the legend', () => {
    const svg = buildScatterSvg(
      [
        { label: 'llm-fw cheap', recall: 0.613, fpr: 0.095, group: 'reference' },
        { label: 'protectai-deberta @0.5', recall: 0.77, fpr: 0.13, group: 'competitor' },
      ],
      'Recall vs FPR — heldout',
    )
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
    expect(svg).toContain('Recall vs FPR — heldout')
    expect(svg).toContain('llm-fw cheap')
    expect(svg).toContain('protectai-deberta @0.5')
    expect(svg).toContain('competitor')
    expect(svg).toContain('llm-fw (reference)')
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
