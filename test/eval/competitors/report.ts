/**
 * Pure report-building functions for the competitor head-to-head benchmark.
 * Kept dependency-free and side-effect-free (no fs/process) so the unit tests
 * can exercise them with fixture data and no model downloads:
 * test/eval/competitors/run.ts is the only place that touches disk/network.
 */

export interface SplitAdapterResult {
  name: string
  /**
   * True for llm-fw's own presets. They are adapters like any other, measured
   * in the same run on the same rows. The report used to copy their numbers
   * from a document instead, and went on printing 43.5% safeguard recall for
   * the default configuration four months after it measured 76.3% (#533).
   */
  own?: boolean
  ran: boolean
  /** Present when ran === false; explains why (surfaced verbatim). */
  reason?: string
  n?: number
  tp?: number
  fn?: number
  tn?: number
  fp?: number
  /** 0..1, or null when the split has no attack rows (benign-only set). */
  recall?: number | null
  /** 0..1, or null when the split has no benign rows (attacks-only set). */
  fpr?: number | null
}

export interface SplitResult {
  /** Dataset file name minus extension, e.g. 'heldout'. */
  dataset: string
  threat: string
  n: number
  adapters: SplitAdapterResult[]
}

export interface ScatterPoint {
  label: string
  /** 0..1 */
  recall: number
  /** 0..1 */
  fpr: number
  group: 'competitor' | 'llm-fw'
}

/** A rate with the counts behind it, or a dash when the split has no such rows. */
function rate(v: number | null | undefined, hit: number | undefined, miss: number | undefined): string {
  if (v === null || v === undefined) return '—'
  const pct = `${(v * 100).toFixed(1)}%`
  return hit === undefined || miss === undefined ? pct : `${pct} (${hit}/${hit + miss})`
}

/** Collects every adapter that did not run, across every split, so the
 *  "adapters not run" note lists each skipped adapter with its reason exactly
 *  once (a skip reason is a property of the adapter/environment, not the
 *  split, so it repeats identically across splits). */
export function collectSkipped(splits: SplitResult[]): { name: string; reason: string }[] {
  const seen = new Map<string, string>()
  for (const split of splits) {
    for (const a of split.adapters) {
      if (!a.ran && !seen.has(a.name)) seen.set(a.name, a.reason ?? 'not run: unavailable')
    }
  }
  return [...seen.entries()].map(([name, reason]) => ({ name, reason }))
}

/** Points for the recall-vs-FPR scatter of one split: every adapter that ran
 *  there. A split without attack rows or without benign rows has only one of
 *  the two axes, so it gets no points. */
export function scatterPointsForSplit(split: SplitResult): ScatterPoint[] {
  const points: ScatterPoint[] = []
  for (const a of split.adapters) {
    if (a.ran && typeof a.recall === 'number' && typeof a.fpr === 'number') {
      points.push({ label: a.name, recall: a.recall, fpr: a.fpr, group: a.own ? 'llm-fw' : 'competitor' })
    }
  }
  return points
}

/** llm-fw's presets first, then the others, each in the order they ran. */
function ordered(adapters: SplitAdapterResult[]): SplitAdapterResult[] {
  return [...adapters.filter(a => a.own), ...adapters.filter(a => !a.own)]
}

function renderSplitTable(split: SplitResult): string {
  const rows = ordered(split.adapters).map(a => {
    const name = a.own ? `**${a.name}**` : a.name
    if (!a.ran) return `| ${name} | — | — | ${a.reason ?? 'not run'} |`
    return `| ${name} | ${rate(a.recall, a.tp, a.fn)} | ${rate(a.fpr, a.fp, a.tn)} | ran |`
  })
  return [
    `### ${split.dataset} (${split.threat}, n=${split.n})`,
    '',
    '| Guardrail | Recall | FPR | Status |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n')
}

export interface BuildMarkdownOptions {
  splits: SplitResult[]
  generatedAt: string
  /** The detection ruleset the llm-fw rows were measured on. */
  ruleset: string
  /** dataset name -> relative path (from the doc) to its scatter SVG, e.g.
   *  'competitors-results/recall-vs-fpr-heldout.svg'. Omit a dataset to skip
   *  embedding a chart for it (e.g. nothing ran there). */
  chartPaths: Record<string, string>
}

export function buildMarkdown(opts: BuildMarkdownOptions): string {
  const { splits, generatedAt, ruleset, chartPaths } = opts
  const skipped = collectSkipped(splits)

  const sections = splits.map(split => {
    const table = renderSplitTable(split)
    const chart = chartPaths[split.dataset]
    return chart
      ? `${table}\n\n![Recall vs FPR — ${split.dataset}](${chart})`
      : table
  })

  const notRunSection = skipped.length
    ? ['## Adapters not run', '', ...skipped.map(s => `- **${s.name}** — ${s.reason}`)].join('\n')
    : '## Adapters not run\n\nAll adapters ran.'

  return [
    '[llm-fw](../README.md) > [Documentation](README.md) > Measurements > Competitor guardrail head-to-head',
    '',
    '# Competitor guardrail head-to-head',
    '',
    `Generated ${generatedAt} on ruleset ${ruleset} by \`npm run bench:competitors\`. Do not edit by hand.`,
    '',
    'Third-party prompt-injection guardrails and llm-fw on the same rows of the same splits' +
    ' (see [BENCHMARK.md](BENCHMARK.md) for what each split is). Recall is attacks blocked, FPR is' +
    ' benign rows blocked, and the counts behind each rate are in brackets. A split with no attack' +
    ' rows has no recall and one with no benign rows has no FPR. Direct injection, indirect' +
    ' injection and benign-only traffic are separate tables and are never averaged.',
    '',
    'Every row is measured in the run that generated this page, the llm-fw rows included (in bold).' +
    ' Two differences in how a row reaches each guardrail are part of what is compared:',
    '',
    '- **llm-fw gets each row on the surface it arrives on** (user prompt, tool result, system' +
    ' prompt, tool definition), inside an Anthropic Messages request, because that is what a proxy' +
    ' sees. A standalone classifier has no notion of a surface and gets the text alone.',
    '- **`protectai/deberta-v3-base-prompt-injection-v2` is also the model behind llm-fw\'s opt-in' +
    ' classifier stage.** Its own row is that model alone at its natural 0.5 threshold. The' +
    ' "llm-fw + classifier" rows are the default pipeline with the same model added at 0.9:' +
    ' "corroborated" is what turning the classifier on gives (a classifier hit blocks only when' +
    ' the heuristic or embedding stage found the text suspicious too), "uncorroborated" sets' +
    ' `detection.classifier.requireCorroboration` to false.',
    '',
    sections.join('\n\n'),
    '',
    notRunSection,
    '',
    '## Reproduce',
    '',
    '```',
    'npm run bench:competitors',
    '```',
    '',
    'Runs each split in its own subprocess with an enlarged heap' +
    ' (`--max-old-space-size=8192`), one guardrail at a time, so a local ONNX model load cannot' +
    ' run a single long-lived process out of memory.',
    '',
  ].join('\n')
}

// ── SVG scatter (no chart library — same hand-rolled approach as
//    scripts/gen-load-charts.ts, kept intentionally small). ────────────────

function xe(s: string | number): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const COLOR = { competitor: '#1565c0', own: '#e65100', axis: '#757575', grid: '#eeeeee', text: '#212121' }

export function buildScatterSvg(points: ScatterPoint[], title: string): string {
  const W = 520, H = 420
  const ox = 60, oy = 40, cw = W - ox - 40, ch = H - oy - 70

  const xv = (fpr: number) => ox + fpr * cw // FPR 0..1 -> pixels
  const yv = (recall: number) => oy + ch - recall * ch // Recall 0..1 -> pixels (top = 100%)

  const out: string[] = []
  out.push(`<text x="${W / 2}" y="20" font-size="14" font-weight="700" fill="${COLOR.text}" text-anchor="middle" font-family="sans-serif">${xe(title)}</text>`)

  // Grid + axis labels (0/25/50/75/100%).
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4
    const gy = oy + ch - frac * ch
    const gx = ox + frac * cw
    out.push(`<line x1="${ox}" y1="${gy}" x2="${ox + cw}" y2="${gy}" stroke="${COLOR.grid}" stroke-width="1" />`)
    out.push(`<text x="${ox - 8}" y="${gy + 4}" font-size="10" fill="${COLOR.axis}" text-anchor="end" font-family="sans-serif">${Math.round(frac * 100)}%</text>`)
    out.push(`<line x1="${gx}" y1="${oy}" x2="${gx}" y2="${oy + ch}" stroke="${COLOR.grid}" stroke-width="1" />`)
    out.push(`<text x="${gx}" y="${oy + ch + 16}" font-size="10" fill="${COLOR.axis}" text-anchor="middle" font-family="sans-serif">${Math.round(frac * 100)}%</text>`)
  }
  out.push(`<line x1="${ox}" y1="${oy + ch}" x2="${ox + cw}" y2="${oy + ch}" stroke="${COLOR.axis}" stroke-width="1.5" />`)
  out.push(`<line x1="${ox}" y1="${oy}" x2="${ox}" y2="${oy + ch}" stroke="${COLOR.axis}" stroke-width="1.5" />`)
  out.push(`<text x="${ox + cw / 2}" y="${H - 32}" font-size="11" fill="${COLOR.axis}" text-anchor="middle" font-family="sans-serif">FPR (benign blocked) — lower is better →</text>`)
  out.push(`<text x="16" y="${oy + ch / 2}" font-size="11" fill="${COLOR.axis}" text-anchor="middle" font-family="sans-serif" transform="rotate(-90 16 ${oy + ch / 2})">Recall (attacks blocked) — higher is better ↑</text>`)

  points.forEach((p, i) => {
    const x = xv(Math.min(p.fpr, 1))
    const y = yv(Math.min(p.recall, 1))
    const fill = p.group === 'competitor' ? COLOR.competitor : COLOR.own
    out.push(`<circle cx="${x}" cy="${y}" r="5" fill="${fill}" stroke="#fff" stroke-width="1.5" />`)
    // Alternate label offset a little per index so overlapping points stay legible.
    const dy = i % 2 === 0 ? -10 : 16
    out.push(`<text x="${x}" y="${y + dy}" font-size="9" fill="${fill}" text-anchor="middle" font-family="sans-serif">${xe(p.label)}</text>`)
  })

  // Legend.
  const ly = H - 12
  out.push(`<circle cx="${ox}" cy="${ly}" r="4" fill="${COLOR.competitor}" />`)
  out.push(`<text x="${ox + 8}" y="${ly + 3}" font-size="9" fill="${COLOR.text}" font-family="sans-serif">competitor</text>`)
  out.push(`<circle cx="${ox + 90}" cy="${ly}" r="4" fill="${COLOR.own}" />`)
  out.push(`<text x="${ox + 98}" y="${ly + 3}" font-size="9" fill="${COLOR.text}" font-family="sans-serif">llm-fw (same run)</text>`)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" />`,
    out.join('\n'),
    `</svg>`,
  ].join('\n')
}
