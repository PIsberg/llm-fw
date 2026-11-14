/**
 * Version-over-version comparison of load benchmark results
 * (test/load/compare.ts, npm run bench:load:compare).
 *
 * One run of `npm run bench:load` is one sample. Two runs of the same commit
 * on one laptop have differed by 7 to 31% (docs/LOADTESTS.md, 2026-11-01), so
 * a single run per version cannot tell a regression from noise. Runs of the
 * same commit are grouped, every metric is reported as the median with the
 * min-max range, and a difference only counts as a change when the two ranges
 * do not overlap. With one run per version nothing can be called a change.
 */

export interface BenchStep {
  workload: string
  concurrency: number
  throughputRps: number
  latency: { p50Ms: number; p95Ms: number; p99Ms: number }
  cpuPct: number
  cpuMsPerRequest: number
  peakRssMb: number
  eventLoop: { p99Ms: number }
  unexpected?: number
  errors?: number
}

export interface BenchResult {
  kind: string
  meta: {
    version: string
    ruleset: string
    commit: string
    dirty: boolean
    timestamp: string
    node: string
    cpu: string
    cores: number
    runtime?: Record<string, string>
  }
  config: { workloads: string[]; concurrency: number[]; stepS: number; warmupS: number; agentKb: number }
  settings?: { detection?: unknown; detectionOverride?: unknown }
  startup: { initMs: number; processReadyMs: number; idle: { rssMb: number }; idleAfter?: { rssMb: number } }
  coldFirstRequestMs?: Record<string, number>
  warnings?: string[]
  steps: BenchStep[]
}

export interface Spread { median: number; min: number; max: number; n: number }

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Median and range of a sample. The median of an even count is the mean of the middle two. */
export function spread(values: readonly number[]): Spread {
  if (values.length === 0) throw new Error('spread of no values')
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
  return { median: round2(median), min: s[0]!, max: s[s.length - 1]!, n: s.length }
}

export type Better = 'higher' | 'lower'

export interface Delta {
  /** Change of the median, in percent of the baseline's median. */
  pct: number
  /** The two ranges do not overlap, so the difference is larger than the run-to-run spread. */
  beyondNoise: boolean
  /** Whether the change goes the way `better` wants. Undefined while it is within noise. */
  improved?: boolean
}

/**
 * The change from `base` to `next`. It counts as beyond noise only when both
 * sides have at least two runs and their ranges do not overlap: one run has
 * no range, and calling a single-sample difference a change is exactly the
 * mistake this module exists to prevent.
 */
export function delta(base: Spread, next: Spread, better: Better): Delta {
  const pct = base.median === 0 ? 0 : round2(((next.median - base.median) / base.median) * 100)
  const beyondNoise = base.n >= 2 && next.n >= 2 && (next.min > base.max || next.max < base.min)
  if (!beyondNoise) return { pct, beyondNoise }
  return { pct, beyondNoise, improved: better === 'higher' ? next.median > base.median : next.median < base.median }
}

export interface Version {
  label: string
  version: string
  ruleset: string
  commit: string
  dirty: boolean
  runs: number
  timestamps: string[]
  node: string
  cpu: string
  cores: number
  runtime?: Record<string, string>
  /** The LOAD_BENCH_DETECTION override these runs used ("embedding.spinWait=true"), or ''. */
  override: string
  /** Each run's own warnings, prefixed with the run's timestamp. A noisy run still counts; it is named here. */
  warnings: string[]
}

/** The per-level metrics compared, with which direction is better. */
export const STEP_METRICS = {
  throughputRps: { label: 'Throughput', unit: 'req/s', better: 'higher', get: (s: BenchStep) => s.throughputRps },
  p50Ms: { label: 'p50 latency', unit: 'ms', better: 'lower', get: (s: BenchStep) => s.latency.p50Ms },
  p95Ms: { label: 'p95 latency', unit: 'ms', better: 'lower', get: (s: BenchStep) => s.latency.p95Ms },
  p99Ms: { label: 'p99 latency', unit: 'ms', better: 'lower', get: (s: BenchStep) => s.latency.p99Ms },
  cpuPct: { label: 'CPU, % of one core', unit: '%', better: 'lower', get: (s: BenchStep) => s.cpuPct },
  cpuMsPerRequest: { label: 'CPU time per request', unit: 'ms', better: 'lower', get: (s: BenchStep) => s.cpuMsPerRequest },
  peakRssMb: { label: 'Peak RSS', unit: 'MB', better: 'lower', get: (s: BenchStep) => s.peakRssMb },
  eventLoopP99Ms: { label: 'Event-loop delay p99', unit: 'ms', better: 'lower', get: (s: BenchStep) => s.eventLoop.p99Ms },
} as const satisfies Record<string, { label: string; unit: string; better: Better; get: (s: BenchStep) => number }>

export type StepMetric = keyof typeof STEP_METRICS

/** One headline figure: a value per version, and its change from the first version. */
export interface HeadlineRow {
  key: string
  group: string
  label: string
  unit: string
  better: Better
  values: Record<string, Spread>
  deltas: Record<string, Delta>
}

export interface Comparison {
  kind: 'llm-fw-load-comparison'
  schema: 1
  /** In the order given; the first is the baseline every delta is measured from. */
  versions: Version[]
  config: BenchResult['config']
  /** steps[workload][concurrency][label][metric] */
  steps: Record<string, Record<string, Record<string, Record<StepMetric, Spread>>>>
  headline: HeadlineRow[]
  /** Detection settings that differ between versions, as dotted paths; empty when no run recorded them. */
  settingsDiff: { path: string; values: Record<string, unknown> }[]
  notes: string[]
}

function sameConfig(a: BenchResult['config'], b: BenchResult['config']): boolean {
  return a.stepS === b.stepS && a.warmupS === b.warmupS && a.agentKb === b.agentKb &&
    a.workloads.join() === b.workloads.join() && a.concurrency.join() === b.concurrency.join()
}

/** Flatten nested settings into dotted paths, for a readable diff. */
function flatten(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  } else {
    out[prefix] = JSON.stringify(value)
  }
  return out
}

export interface CompareOptions {
  /**
   * Display names keyed by commit; the default is "<version> (<commit>)". A
   * run with a LOAD_BENCH_DETECTION override keeps it in its label
   * ("main, embedding.spinWait=true"), so the name never hides the setting.
   */
  labels?: Record<string, string>
}

/** "embedding.spinWait=true", or '' for a run without a LOAD_BENCH_DETECTION override. */
export function overrideLabel(r: BenchResult): string {
  const o = r.settings?.detectionOverride
  if (o === undefined || o === null || (typeof o === 'object' && Object.keys(o).length === 0)) return ''
  return Object.entries(flatten(o)).map(([k, v]) => `${k}=${v}`).join(', ')
}

/**
 * Group runs by commit, dirty state and LOAD_BENCH_DETECTION override, in the
 * order each group first appears, and compare every metric against the first
 * group. The override is part of the key so that one commit measured with a
 * default switched (main with spinWait on, to compare with a version that
 * spun) is a version of its own, not noise in the plain runs. Runs measured
 * with different benchmark settings are refused: a 10 s level against a 3 s
 * one is not the same measurement.
 */
export function compareRuns(runs: readonly BenchResult[], opts: CompareOptions = {}): Comparison {
  if (runs.length === 0) throw new Error('no results to compare')
  for (const r of runs) {
    if (r.kind !== 'llm-fw-load-benchmark') throw new Error(`not a load benchmark result (kind=${JSON.stringify(r.kind)})`)
  }
  const config = runs[0]!.config
  for (const r of runs) {
    if (!sameConfig(config, r.config)) {
      throw new Error(`run ${r.meta.commit} at ${r.meta.timestamp} used different benchmark settings ` +
        `(${JSON.stringify(r.config)} against ${JSON.stringify(config)}); compare runs made with the same LOAD_BENCH_* values`)
    }
  }

  const groups = new Map<string, BenchResult[]>()
  for (const r of runs) {
    const key = `${r.meta.commit}${r.meta.dirty ? '+dirty' : ''} ${overrideLabel(r)}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }

  const notes: string[] = []
  const cpus = new Set(runs.map(r => `${r.meta.cpu} (${r.meta.cores} threads)`))
  if (cpus.size > 1) notes.push(`runs come from different machines: ${[...cpus].join('; ')}`)
  const nodes = new Set(runs.map(r => r.meta.node))
  if (nodes.size > 1) notes.push(`runs used different Node versions: ${[...nodes].join(', ')}`)

  const versions: Version[] = []
  const byLabel = new Map<string, BenchResult[]>()
  for (const [key, rs] of groups) {
    const m = rs[0]!.meta
    const name = opts.labels?.[m.commit] ?? `${m.version} (${m.commit}${m.dirty ? ', dirty' : ''})`
    const override = overrideLabel(rs[0]!)
    const label = override ? `${name}, ${override}` : name
    if (byLabel.has(label)) throw new Error(`two commits share the label "${label}" (${key})`)
    byLabel.set(label, rs)
    versions.push({
      label, version: m.version, ruleset: m.ruleset, commit: m.commit, dirty: m.dirty, runs: rs.length,
      timestamps: rs.map(r => r.meta.timestamp), node: m.node, cpu: m.cpu, cores: m.cores, runtime: m.runtime, override,
      warnings: rs.flatMap(r => (r.warnings ?? []).map(w => `${r.meta.timestamp}: ${w}`)),
    })
    if (rs.length < 2) notes.push(`${label} has one run, so no difference from or to it can be told from noise; run it again`)
  }

  const steps: Comparison['steps'] = {}
  for (const w of config.workloads) {
    steps[w] = {}
    for (const c of config.concurrency) {
      const perVersion: Record<string, Record<StepMetric, Spread>> = {}
      for (const v of versions) {
        const matching = byLabel.get(v.label)!.map(r => r.steps.find(s => s.workload === w && s.concurrency === c))
          .filter((s): s is BenchStep => s !== undefined)
        if (matching.length === 0) continue
        perVersion[v.label] = Object.fromEntries(
          (Object.keys(STEP_METRICS) as StepMetric[]).map(k => [k, spread(matching.map(STEP_METRICS[k].get))]),
        ) as Record<StepMetric, Spread>
      }
      steps[w][String(c)] = perVersion
    }
  }

  const headline: HeadlineRow[] = []
  const base = versions[0]!.label
  const row = (key: string, group: string, label: string, unit: string, better: Better, per: (r: BenchResult) => number | undefined): void => {
    const values: Record<string, Spread> = {}
    for (const v of versions) {
      const xs = byLabel.get(v.label)!.map(per).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
      if (xs.length > 0) values[v.label] = spread(xs)
    }
    if (!values[base]) return
    const deltas: Record<string, Delta> = {}
    for (const v of versions.slice(1)) {
      if (values[v.label]) deltas[v.label] = delta(values[base]!, values[v.label]!, better)
    }
    headline.push({ key, group, label, unit, better, values, deltas })
  }
  const lowest = Math.min(...config.concurrency)
  const at = (r: BenchResult, w: string, c: number): BenchStep | undefined => r.steps.find(s => s.workload === w && s.concurrency === c)
  for (const w of config.workloads) {
    const ofW = (r: BenchResult): BenchStep[] => r.steps.filter(s => s.workload === w)
    row(`${w}.peakRps`, w, 'Peak throughput', 'req/s', 'higher', r => Math.max(...ofW(r).map(s => s.throughputRps)))
    row(`${w}.p50At1`, w, `p50 at ${lowest} client${lowest === 1 ? '' : 's'}`, 'ms', 'lower', r => at(r, w, lowest)?.latency.p50Ms)
    row(`${w}.p99At1`, w, `p99 at ${lowest} client${lowest === 1 ? '' : 's'}`, 'ms', 'lower', r => at(r, w, lowest)?.latency.p99Ms)
    row(`${w}.cpuMsAt1`, w, `CPU per request at ${lowest} client${lowest === 1 ? '' : 's'}`, 'ms', 'lower', r => at(r, w, lowest)?.cpuMsPerRequest)
    row(`${w}.coldMs`, w, 'First request, cold', 'ms', 'lower', r => r.coldFirstRequestMs?.[w])
    row(`${w}.worstLoopMs`, w, 'Worst event-loop p99', 'ms', 'lower', r => Math.max(...ofW(r).map(s => s.eventLoop.p99Ms)))
  }
  row('memory.idleRss', 'memory', 'RSS idle after start', 'MB', 'lower', r => r.startup.idle.rssMb)
  row('memory.peakRss', 'memory', 'Peak RSS under load', 'MB', 'lower', r => Math.max(...r.steps.map(s => s.peakRssMb)))
  row('memory.idleAfterRss', 'memory', 'RSS idle after load', 'MB', 'lower', r => r.startup.idleAfter?.rssMb)
  row('startup.initMs', 'startup', 'Model and pipeline init', 'ms', 'lower', r => r.startup.initMs)
  row('startup.readyMs', 'startup', 'Process start to ready', 'ms', 'lower', r => r.startup.processReadyMs)

  const settingsDiff: Comparison['settingsDiff'] = []
  const flat = new Map(versions.map(v => {
    const s = byLabel.get(v.label)![0]!.settings
    return [v.label, s?.detection === undefined ? undefined : flatten(s.detection)] as const
  }))
  const recorded = [...flat.values()].filter((f): f is Record<string, string> => f !== undefined)
  if (recorded.length > 0 && recorded.length < versions.length) {
    notes.push(`detection settings were recorded by ${recorded.length} of ${versions.length} versions; older runs predate the field`)
  }
  if (recorded.length > 1) {
    const paths = new Set(recorded.flatMap(f => Object.keys(f)))
    for (const p of [...paths].sort()) {
      const vals = versions.filter(v => flat.get(v.label)).map(v => [v.label, flat.get(v.label)![p]] as const)
      if (new Set(vals.map(([, x]) => x)).size > 1) {
        settingsDiff.push({ path: p, values: Object.fromEntries(vals.map(([l, x]) => [l, x === undefined ? undefined : JSON.parse(x)])) })
      }
    }
  }

  return { kind: 'llm-fw-load-comparison', schema: 1, versions, config, steps, headline, settingsDiff, notes }
}

function fmtValue(v: number, unit: string): string {
  if (unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`
  if (unit === 'req/s') return `${v >= 100 ? Math.round(v) : v.toFixed(1)} req/s`
  if (unit === 'MB') return `${Math.round(v)} MB`
  return `${Math.round(v)}${unit}`
}

function fmtSpread(s: Spread, unit: string): string {
  return s.n < 2 || s.min === s.max ? fmtValue(s.median, unit) : `${fmtValue(s.median, unit)} (${fmtValue(s.min, unit)}-${fmtValue(s.max, unit)})`
}

/** "+12.5%, better", "-3.0%, within noise". */
export function describeDelta(d: Delta): string {
  const sign = d.pct > 0 ? '+' : ''
  if (!d.beyondNoise) return `${sign}${d.pct.toFixed(1)}%, within noise`
  return `${sign}${d.pct.toFixed(1)}%, ${d.improved ? 'better' : 'worse'}`
}

const GROUP_TITLE: Record<string, string> = {
  chat: 'Chat prompt', agent: 'Agent request', attack: 'Attack (refused)', memory: 'Memory', startup: 'Startup',
}

/** The comparison as Markdown tables: medians with the range, and the change from the baseline. */
export function comparisonMarkdown(c: Comparison): string {
  const out: string[] = []
  const base = c.versions[0]!
  out.push(`Baseline: ${base.label}. Each cell is the median of the runs, with the range in brackets; ` +
    'a change counts only when the ranges do not overlap.', '')
  out.push('|Version|Ruleset|Commit|Runs|Node|Runtime|', '|---|---|---|---|---|---|')
  for (const v of c.versions) {
    const rt = v.runtime ? Object.entries(v.runtime).map(([k, x]) => `${k} ${x}`).join(', ') : 'not recorded'
    out.push(`|${v.label}|${v.ruleset}|${v.commit}${v.dirty ? ' (dirty)' : ''}|${v.runs}|${v.node}|${rt}|`)
  }
  const groups = [...new Set(c.headline.map(h => h.group))]
  for (const g of groups) {
    out.push('', `### ${GROUP_TITLE[g] ?? g}`, '')
    out.push(`|Metric|${c.versions.map(v => v.label).join('|')}|`, `|---|${c.versions.map(() => '---').join('|')}|`)
    for (const h of c.headline.filter(x => x.group === g)) {
      const cells = c.versions.map(v => {
        const s = h.values[v.label]
        if (!s) return 'n/a'
        const d = h.deltas[v.label]
        return d ? `${fmtSpread(s, h.unit)}, ${describeDelta(d)}` : fmtSpread(s, h.unit)
      })
      out.push(`|${h.label}|${cells.join('|')}|`)
    }
  }
  if (c.settingsDiff.length > 0) {
    out.push('', '### Detection settings that differ', '', `|Setting|${c.versions.map(v => v.label).join('|')}|`, `|---|${c.versions.map(() => '---').join('|')}|`)
    for (const d of c.settingsDiff) out.push(`|\`${d.path}\`|${c.versions.map(v => JSON.stringify(d.values[v.label]) ?? 'n/a').join('|')}|`)
  }
  const warnings = c.versions.flatMap(v => v.warnings.map(w => `${v.label}, ${w}`))
  if (warnings.length > 0 || c.notes.length > 0) {
    out.push('', '### Caveats', '')
    for (const n of c.notes) out.push(`- ${n}`)
    for (const w of warnings) out.push(`- Noisy run: ${w}`)
  }
  return out.join('\n') + '\n'
}
