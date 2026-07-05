/**
 * Pure report-building functions for the competitor head-to-head benchmark
 * (Task B6). Kept dependency-free and side-effect-free (no fs/process) so the
 * unit tests can exercise them with fixture data and no model downloads —
 * test/eval/competitors/run.ts is the only place that touches disk/network.
 */

export interface SplitAdapterResult {
  name: string
  ran: boolean
  /** Present when ran === false; explains why (surfaced verbatim). */
  reason?: string
  n?: number
  tp?: number
  fn?: number
  tn?: number
  fp?: number
  /** 0..1 */
  recall?: number
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

/** A non-adapter comparison point — llm-fw's own presets, taken from
 *  docs/BENCHMARK-IMPROVEMENTS.md rather than re-run (ground rule: don't
 *  re-run our own presets for this report). */
export interface ReferenceRow {
  preset: string
  dataset: string
  n: number
  /** 0..1 */
  recall: number
  /** 0..1, or null when the split has no benign rows. */
  fpr: number | null
}

export interface ScatterPoint {
  label: string
  /** 0..1 */
  recall: number
  /** 0..1 */
  fpr: number
  group: 'competitor' | 'reference'
}

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`)

/** Collects every adapter that reported ran=true, across every split, so the
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

/** Points suitable for the recall-vs-FPR scatter for one split: every adapter
 *  that actually ran there, plus the reference rows for that same split.
 *  Rows with fpr === null (attacks-only sets) are excluded — a scatter axis
 *  cannot place them meaningfully. */
export function scatterPointsForSplit(split: SplitResult, references: ReferenceRow[]): ScatterPoint[] {
  const points: ScatterPoint[] = []
  for (const a of split.adapters) {
    if (a.ran && typeof a.recall === 'number' && typeof a.fpr === 'number') {
      points.push({ label: a.name, recall: a.recall, fpr: a.fpr, group: 'competitor' })
    }
  }
  for (const r of references.filter(r => r.dataset === split.dataset)) {
    if (r.fpr !== null) points.push({ label: r.preset, recall: r.recall, fpr: r.fpr, group: 'reference' })
  }
  return points
}

function renderSplitTable(split: SplitResult, references: ReferenceRow[]): string {
  const rows: string[] = []
  for (const r of references.filter(r => r.dataset === split.dataset)) {
    rows.push(`| **${r.preset}** (reference) | ${pct(r.recall)} | ${pct(r.fpr)} | reference — see docs/BENCHMARK-IMPROVEMENTS.md |`)
  }
  for (const a of split.adapters) {
    const status = a.ran ? 'ran' : (a.reason ?? 'not run')
    rows.push(`| ${a.name} | ${a.ran ? pct(a.recall) : '—'} | ${a.ran ? pct(a.fpr) : '—'} | ${status} |`)
  }
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
  references: ReferenceRow[]
  generatedAt: string
  /** dataset name -> relative path (from the doc) to its scatter SVG, e.g.
   *  'competitors-results/recall-vs-fpr-heldout.svg'. Omit a dataset to skip
   *  embedding a chart for it (e.g. nothing ran there). */
  chartPaths: Record<string, string>
}

export function buildMarkdown(opts: BuildMarkdownOptions): string {
  const { splits, references, generatedAt, chartPaths } = opts
  const skipped = collectSkipped(splits)

  const sections = splits.map(split => {
    const table = renderSplitTable(split, references)
    const chart = chartPaths[split.dataset]
    return chart
      ? `${table}\n\n![Recall vs FPR — ${split.dataset}](${chart})`
      : table
  })

  const notRunSection = skipped.length
    ? ['## Adapters not run', '', ...skipped.map(s => `- **${s.name}** — ${s.reason}`)].join('\n')
    : '## Adapters not run\n\nAll adapters ran.'

  return [
    '# Competitor guardrail head-to-head (Task B6, Option A)',
    '',
    `Generated ${generatedAt}. Independent generalization benchmark (see docs/BENCHMARK.md` +
    ' methodology) run against third-party prompt-injection/jailbreak guardrails on the same' +
    ' held-out splits llm-fw is measured on: recall = attacks blocked, FPR = benign blocked.' +
    ' Different threat models (direct injection vs. indirect injection) are reported separately' +
    ' and never averaged. The llm-fw reference rows are NOT re-run here — they are copied from' +
    ' docs/BENCHMARK-IMPROVEMENTS.md (Round 6) for side-by-side comparison.',
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
    ' (`--max-old-space-size=8192`) so a local ONNX model load cannot OOM a' +
    ' single long-lived process — the lesson from Task B1.',
    '',
  ].join('\n')
}

// ── SVG scatter (no chart library — same hand-rolled approach as
//    scripts/gen-load-charts.ts, kept intentionally small). ────────────────

function xe(s: string | number): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const COLOR = { competitor: '#1565c0', reference: '#e65100', axis: '#757575', grid: '#eeeeee', text: '#212121' }

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
    const fill = p.group === 'competitor' ? COLOR.competitor : COLOR.reference
    out.push(`<circle cx="${x}" cy="${y}" r="5" fill="${fill}" stroke="#fff" stroke-width="1.5" />`)
    // Alternate label offset a little per index so overlapping points stay legible.
    const dy = i % 2 === 0 ? -10 : 16
    out.push(`<text x="${x}" y="${y + dy}" font-size="9" fill="${fill}" text-anchor="middle" font-family="sans-serif">${xe(p.label)}</text>`)
  })

  // Legend.
  const ly = H - 12
  out.push(`<circle cx="${ox}" cy="${ly}" r="4" fill="${COLOR.competitor}" />`)
  out.push(`<text x="${ox + 8}" y="${ly + 3}" font-size="9" fill="${COLOR.text}" font-family="sans-serif">competitor</text>`)
  out.push(`<circle cx="${ox + 90}" cy="${ly}" r="4" fill="${COLOR.reference}" />`)
  out.push(`<text x="${ox + 98}" y="${ly + 3}" font-size="9" fill="${COLOR.text}" font-family="sans-serif">llm-fw (reference)</text>`)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" />`,
    out.join('\n'),
    `</svg>`,
  ].join('\n')
}
