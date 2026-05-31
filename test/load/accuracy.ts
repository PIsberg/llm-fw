/**
 * Scenario B — Accuracy Under Load (Mixed Traffic)
 *
 * Sends a configurable mix of benign and malicious requests concurrently and
 * asserts that the False Positive Rate stays below threshold and the True
 * Positive Rate stays above threshold.
 *
 * Env-var knobs:
 *   LOAD_VUS          concurrent workers           (default: 3)
 *   LOAD_ITERATIONS   requests per worker          (default: 20)
 *   LOAD_BENIGN_RATIO benign fraction 0-1          (default: 0.9 = 90 % benign)
 *   LOAD_FPR_MAX      max allowed FPR in %         (default: 2.0)
 *   LOAD_TPR_MIN      min required TPR in %        (default: 75.0)
 *
 * Exit code: 0 = pass, 1 = threshold violated.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { setupHarness, printTable, fmtMs, type SendFn } from './lib/harness.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const VUS          = parseInt(process.env.LOAD_VUS        ?? '3',   10)
const ITERATIONS   = parseInt(process.env.LOAD_ITERATIONS ?? '20',  10)
const BENIGN_RATIO = parseFloat(process.env.LOAD_BENIGN_RATIO ?? '0.9')
const FPR_MAX      = parseFloat(process.env.LOAD_FPR_MAX  ?? '2.0')
const TPR_MIN      = parseFloat(process.env.LOAD_TPR_MIN  ?? '75.0')

const PROXY_PORT = 19_280
const DASH_PORT  = 19_831

interface WorkerResult {
  tn: number   // benign  → 200 (true negative  — correct pass)
  fp: number   // benign  → 403 (false positive — incorrect block)
  tp: number   // malicious → 403 (true positive  — correct block)
  fn: number   // malicious → 200 (false negative — missed attack)
  latencies: number[]
  errCount: number
}

async function runWorker(
  send: SendFn,
  benign: string[],
  malicious: string[],
  iterations: number,
): Promise<WorkerResult> {
  let tn = 0, fp = 0, tp = 0, fn = 0, errCount = 0
  const latencies: number[] = []

  for (let i = 0; i < iterations; i++) {
    const isBenign = Math.random() < BENIGN_RATIO
    const prompts = isBenign ? benign : malicious
    const prompt = prompts[Math.floor(Math.random() * prompts.length)]!

    const body = JSON.stringify({
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
    })

    try {
      const { statusCode, latencyMs } = await send(body)
      latencies.push(latencyMs)

      if (isBenign) {
        if (statusCode === 200) tn++
        else                    fp++
      } else {
        if (statusCode === 403) tp++
        else                    fn++
      }
    } catch {
      errCount++
    }
  }

  return { tn, fp, tp, fn, latencies, errCount }
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║  llm-fw  •  Load Test  •  Scenario B: Accuracy      ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  const totalReqs = VUS * ITERATIONS
  console.log(`  VUs: ${VUS}  |  Iterations/VU: ${ITERATIONS}  |  Total: ${totalReqs}  |  Benign ratio: ${(BENIGN_RATIO * 100).toFixed(0)}%`)
  console.log(`  FPR ceiling: ${FPR_MAX}%  |  TPR floor: ${TPR_MIN}%\n`)

  const benign:   string[] = JSON.parse(readFileSync(join(__dir, 'data', 'benign.json'),   'utf8'))
  const malicious: string[] = JSON.parse(readFileSync(join(__dir, 'data', 'malicious.json'), 'utf8'))

  console.log('Initialising proxy and mock upstream (loading embedding model)…')
  const harness = await setupHarness(PROXY_PORT, DASH_PORT)
  console.log('Ready. Starting load…\n')

  const workers = Array.from({ length: VUS }, () =>
    runWorker(harness.send, benign, malicious, ITERATIONS)
  )
  const results = await Promise.all(workers)

  await harness.teardown()

  // Aggregate confusion matrix
  const tn = results.reduce((s, r) => s + r.tn, 0)
  const fp = results.reduce((s, r) => s + r.fp, 0)
  const tp = results.reduce((s, r) => s + r.tp, 0)
  const fn = results.reduce((s, r) => s + r.fn, 0)
  const errCount = results.reduce((s, r) => s + r.errCount, 0)

  const allLat = results.flatMap(r => r.latencies).sort((a, b) => a - b)
  const avgLat = allLat.length > 0 ? allLat.reduce((s, v) => s + v, 0) / allLat.length : 0
  const p99Lat = allLat.length > 0 ? allLat[Math.ceil(allLat.length * 0.99) - 1]! : 0

  const fpr = (tn + fp) > 0 ? (fp / (tn + fp)) * 100 : 0
  const tpr = (tp + fn) > 0 ? (tp / (tp + fn)) * 100 : 0

  printTable('Confusion Matrix', [
    ['True  Negatives (benign  → 200)',   tn],
    ['False Positives (benign  → 403)',   fp],
    ['True  Positives (malicious → 403)', tp],
    ['False Negatives (malicious → 200)', fn],
    ['Errors',                             errCount],
  ])

  printTable('Rates', [
    ['False Positive Rate (FPR)',  `${fpr.toFixed(2)}%  (ceiling: ${FPR_MAX}%)`],
    ['True  Positive Rate (TPR)', `${tpr.toFixed(2)}%  (floor:   ${TPR_MIN}%)`],
    ['Avg latency',                fmtMs(avgLat)],
    ['p99 latency',                fmtMs(p99Lat)],
  ])

  const failures: string[] = []
  if (fpr > FPR_MAX)
    failures.push(`FPR ${fpr.toFixed(2)}% exceeds ceiling of ${FPR_MAX}% (${fp} benign requests blocked)`)
  if (tpr < TPR_MIN && (tp + fn) > 0)
    failures.push(`TPR ${tpr.toFixed(2)}% is below floor of ${TPR_MIN}% (${fn} attacks missed)`)

  if (failures.length === 0) {
    console.log('\n✓ All thresholds met. Scenario B PASSED.\n')
    process.exit(0)
  } else {
    console.log('\n✗ Threshold violations:')
    for (const f of failures) console.log(`  • ${f}`)
    console.log('\nScenario B FAILED.\n')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
