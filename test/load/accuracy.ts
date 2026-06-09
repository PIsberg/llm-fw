/**
 * Scenario B — Accuracy Under Load (Mixed Traffic)
 *
 * Env-var knobs:
 *   LOAD_VUS           concurrent workers     (default: 3)
 *   LOAD_ITERATIONS    requests per worker    (default: 20)
 *   LOAD_BENIGN_RATIO  benign fraction 0-1    (default: 0.9)
 *   LOAD_FPR_MAX       max allowed FPR %      (default: 2.0)
 *   LOAD_TPR_MIN       min required TPR %     (default: 70.0)
 *   LOAD_SWEEP         "1" = deterministic full sweep: every benign and
 *                      malicious corpus entry exactly once, split across VUs
 *                      (ignores LOAD_ITERATIONS / LOAD_BENIGN_RATIO)
 *   LOAD_OUTPUT_FILE   path to write JSON results (optional)
 *
 * Exit code: 0 = pass, 1 = threshold violated.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { setupHarness, printTable, fmtMs, percentile, type SendFn } from './lib/harness.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const VUS          = parseInt(process.env.LOAD_VUS          ?? '3',   10)
const ITERATIONS   = parseInt(process.env.LOAD_ITERATIONS   ?? '20',  10)
const BENIGN_RATIO = parseFloat(process.env.LOAD_BENIGN_RATIO ?? '0.9')
const FPR_MAX      = parseFloat(process.env.LOAD_FPR_MAX    ?? '2.0')
// Heuristic+embedding only (no judge). Judge would push TPR higher still.
const TPR_MIN      = parseFloat(process.env.LOAD_TPR_MIN    ?? '70.0')
const SWEEP        = process.env.LOAD_SWEEP === '1'
const OUTPUT_FILE  = process.env.LOAD_OUTPUT_FILE ?? ''

const PROXY_PORT = 19_280
const DASH_PORT  = 19_831

/** One labelled attack prompt. `class` drives the per-class scorecard. */
interface MaliciousEntry { class: string; prompt: string }

interface Request { isBenign: boolean; prompt: string; cls: string }

/**
 * Build a pre-shuffled request list with an exact benign/malicious split.
 * Using a fixed count eliminates the count-variance that probabilistic
 * per-request sampling produces at small sample sizes (e.g. CI runs where
 * 3 VUs × 20 iterations gives only ~6 expected malicious draws, and the
 * binomial variance can drop that to 2–3, collapsing TPR).
 */
function buildRequestList(
  benign: string[],
  malicious: MaliciousEntry[],
  iterations: number,
): Request[] {
  const nMalicious = Math.max(1, Math.round(iterations * (1 - BENIGN_RATIO)))
  const nBenign    = iterations - nMalicious
  const pick = <T>(pool: T[]): T => pool[Math.floor(Math.random() * pool.length)]!

  const list: Request[] = [
    ...Array.from({ length: nBenign }, () =>
      ({ isBenign: true, prompt: pick(benign), cls: 'benign' })),
    ...Array.from({ length: nMalicious }, () => {
      const m = pick(malicious)
      return { isBenign: false, prompt: m.prompt, cls: m.class }
    }),
  ]
  return shuffle(list)
}

/** Fisher-Yates shuffle so malicious requests are spread across the run. */
function shuffle(list: Request[]): Request[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j]!, list[i]!]
  }
  return list
}

/** Per-attack-class confusion counts (benign traffic uses tn/fp). */
interface ClassCounts { tp: number; fn: number; tn: number; fp: number }

interface WorkerResult {
  tn: number; fp: number; tp: number; fn: number
  perClass: Record<string, ClassCounts>
  misses: { cls: string; prompt: string }[]
  latencies: number[]
  errCount: number
}

async function runWorker(
  send: SendFn,
  requests: Request[],
): Promise<WorkerResult> {
  let tn = 0, fp = 0, tp = 0, fn = 0, errCount = 0
  const latencies: number[] = []
  const perClass: Record<string, ClassCounts> = {}
  const misses: { cls: string; prompt: string }[] = []

  for (const { isBenign, prompt, cls } of requests) {
    const body = JSON.stringify({
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
    })

    const bucket = (perClass[cls] ??= { tp: 0, fn: 0, tn: 0, fp: 0 })

    try {
      const { statusCode, latencyMs } = await send(body)
      latencies.push(latencyMs)
      if (isBenign) {
        if (statusCode === 200) { tn++; bucket.tn++ }
        else { fp++; bucket.fp++; misses.push({ cls: 'benign(FP)', prompt }) }
      } else {
        if (statusCode === 403) { tp++; bucket.tp++ }
        else { fn++; bucket.fn++; misses.push({ cls, prompt }) }
      }
    } catch {
      errCount++
    }
  }

  return { tn, fp, tp, fn, perClass, misses, latencies, errCount }
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║  llm-fw  •  Load Test  •  Scenario B: Accuracy      ║')
  console.log('╚══════════════════════════════════════════════════════╝')

  const benign: string[] = JSON.parse(readFileSync(join(__dir, 'data', 'benign.json'), 'utf8'))
  const malicious: MaliciousEntry[] = JSON.parse(readFileSync(join(__dir, 'data', 'malicious.json'), 'utf8'))

  // Request plan. Mixed-traffic mode samples randomly at BENIGN_RATIO; sweep
  // mode visits every corpus entry exactly once so per-class rates are exact
  // and reproducible (used by the scorecard generator).
  const requestLists: Request[][] = []
  if (SWEEP) {
    const all = shuffle([
      ...benign.map(prompt => ({ isBenign: true, prompt, cls: 'benign' })),
      ...malicious.map(m => ({ isBenign: false, prompt: m.prompt, cls: m.class })),
    ])
    const per = Math.ceil(all.length / VUS)
    for (let i = 0; i < all.length; i += per) requestLists.push(all.slice(i, i + per))
    console.log(`  SWEEP mode  |  VUs: ${requestLists.length}  |  Total: ${all.length}  (${benign.length} benign + ${malicious.length} malicious)`)
  } else {
    for (let i = 0; i < VUS; i++) requestLists.push(buildRequestList(benign, malicious, ITERATIONS))
    console.log(`  VUs: ${VUS}  |  Iterations/VU: ${ITERATIONS}  |  Total: ${VUS * ITERATIONS}  |  Benign: ${(BENIGN_RATIO * 100).toFixed(0)}%`)
  }
  console.log(`  FPR ceiling: ${FPR_MAX}%  |  TPR floor: ${TPR_MIN}%\n`)

  console.log('Initialising proxy and mock upstream (loading embedding model)…')
  const harness = await setupHarness(PROXY_PORT, DASH_PORT)
  console.log('Ready. Starting load…\n')

  const results = await Promise.all(requestLists.map(list => runWorker(harness.send, list)))

  await harness.teardown()

  const tn = results.reduce((s, r) => s + r.tn, 0)
  const fp = results.reduce((s, r) => s + r.fp, 0)
  const tp = results.reduce((s, r) => s + r.tp, 0)
  const fn = results.reduce((s, r) => s + r.fn, 0)
  const errCount = results.reduce((s, r) => s + r.errCount, 0)

  const perClass: Record<string, ClassCounts> = {}
  for (const r of results) {
    for (const [cls, c] of Object.entries(r.perClass)) {
      const agg = (perClass[cls] ??= { tp: 0, fn: 0, tn: 0, fp: 0 })
      agg.tp += c.tp; agg.fn += c.fn; agg.tn += c.tn; agg.fp += c.fp
    }
  }
  const misses = results.flatMap(r => r.misses)

  const allLat = results.flatMap(r => r.latencies).sort((a, b) => a - b)
  const avgLat = allLat.length > 0 ? allLat.reduce((s, v) => s + v, 0) / allLat.length : 0
  const p50Lat = percentile(allLat, 50)
  const p95Lat = percentile(allLat, 95)
  const p99Lat = percentile(allLat, 99)

  const fpr = (tn + fp) > 0 ? (fp / (tn + fp)) * 100 : 0
  const tpr = (tp + fn) > 0 ? (tp / (tp + fn)) * 100 : 0

  printTable('Confusion Matrix', [
    ['True  Negatives (benign  → 200)',    tn],
    ['False Positives (benign  → 403)',    fp],
    ['True  Positives (malicious → 403)',  tp],
    ['False Negatives (malicious → 200)', fn],
    ['Errors',                             errCount],
  ])

  printTable('Per-class detection (TP/total)', Object.entries(perClass)
    .filter(([cls]) => cls !== 'benign')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, c]) => [cls, `${c.tp}/${c.tp + c.fn}`]))

  printTable('Rates & Latency', [
    ['False Positive Rate (FPR)',  `${fpr.toFixed(2)}%  (ceiling: ${FPR_MAX}%)`],
    ['True  Positive Rate (TPR)',  `${tpr.toFixed(2)}%  (floor:   ${TPR_MIN}%)`],
    ['p50 latency',                fmtMs(p50Lat)],
    ['p95 latency',                fmtMs(p95Lat)],
    ['p99 latency',                fmtMs(p99Lat)],
    ['Avg latency',                fmtMs(avgLat)],
  ])

  if (misses.length) {
    printTable('Missed (FN) / wrongly blocked (FP)', misses
      .slice(0, 30)
      .map(m => [m.cls, m.prompt.replace(/\s+/g, ' ').slice(0, 60)]))
  }

  const failures: string[] = []
  if (fpr > FPR_MAX)
    failures.push(`FPR ${fpr.toFixed(2)}% exceeds ceiling of ${FPR_MAX}% (${fp} benign blocked)`)
  if (tpr < TPR_MIN && (tp + fn) > 0)
    failures.push(`TPR ${tpr.toFixed(2)}% below floor of ${TPR_MIN}% (${fn} attacks missed)`)

  const passed = failures.length === 0

  // JSON output
  if (OUTPUT_FILE) {
    const output = {
      scenario: 'accuracy' as const,
      timestamp: new Date().toISOString(),
      config: { vus: VUS, iterations: ITERATIONS, benignRatio: BENIGN_RATIO, fprMax: FPR_MAX, tprMin: TPR_MIN, sweep: SWEEP },
      results: {
        confusionMatrix: { tn, fp, tp, fn },
        perClass,
        fpr: parseFloat(fpr.toFixed(4)),
        tpr: parseFloat(tpr.toFixed(4)),
        avgLatencyMs: parseFloat(avgLat.toFixed(1)),
        p50LatencyMs: p50Lat,
        p95LatencyMs: p95Lat,
        p99LatencyMs: p99Lat,
        errCount,
      },
      passed,
      failures,
    }
    mkdirSync(join(OUTPUT_FILE, '..'), { recursive: true })
    writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2))
    console.log(`\nResults written → ${OUTPUT_FILE}`)
  }

  if (passed) {
    console.log('\n✓ All thresholds met. Scenario B PASSED.\n')
    process.exit(0)
  } else {
    console.log('\n✗ Threshold violations:')
    for (const f of failures) console.log(`  • ${f}`)
    console.log('\nScenario B FAILED.\n')
    process.exit(1)
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
