/**
 * Scenario A — Pure Performance (Benign Stress Test)
 *
 * Sends 100% benign traffic through the proxy for a configurable duration and
 * asserts that no legitimate requests are blocked (FPR = 0) and that p99
 * latency stays within threshold.
 *
 * Env-var knobs (set small in CI, large for a full local run):
 *   LOAD_VUS          virtual users / concurrent workers  (default: 5)
 *   LOAD_DURATION_S   test duration in seconds             (default: 20)
 *   LOAD_P99_MS       p99 latency ceiling in ms            (default: 5000)
 *
 * Exit code: 0 = pass, 1 = threshold violated.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { setupHarness, percentile, printTable, fmtMs, type SendFn } from './lib/harness.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const VUS           = parseInt(process.env.LOAD_VUS        ?? '5',    10)
const DURATION_MS   = parseInt(process.env.LOAD_DURATION_S ?? '20',   10) * 1000
const P99_THRESHOLD = parseInt(process.env.LOAD_P99_MS     ?? '5000', 10)

const PROXY_PORT = 19_180
const DASH_PORT  = 19_731

interface WorkerResult {
  latencies: number[]
  fpCount: number    // benign requests that got 403
  errCount: number
  reqCount: number
}

async function runWorker(send: SendFn, prompts: string[], deadline: number): Promise<WorkerResult> {
  const latencies: number[] = []
  let fpCount = 0, errCount = 0, reqCount = 0

  while (Date.now() < deadline) {
    const prompt = prompts[Math.floor(Math.random() * prompts.length)]!
    const body = JSON.stringify({
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
    })
    try {
      const { statusCode, latencyMs } = await send(body)
      latencies.push(latencyMs)
      reqCount++
      if (statusCode === 403) fpCount++
    } catch {
      errCount++
    }
  }

  return { latencies, fpCount, errCount, reqCount }
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║  llm-fw  •  Load Test  •  Scenario A: Performance   ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log(`  VUs: ${VUS}  |  Duration: ${DURATION_MS / 1000}s  |  p99 ceiling: ${P99_THRESHOLD}ms\n`)

  const benignPrompts: string[] = JSON.parse(
    readFileSync(join(__dir, 'data', 'benign.json'), 'utf8')
  )

  console.log('Initialising proxy and mock upstream (loading embedding model)…')
  const harness = await setupHarness(PROXY_PORT, DASH_PORT)
  console.log('Ready. Starting load…\n')

  const deadline = Date.now() + DURATION_MS
  const workers = Array.from({ length: VUS }, () => runWorker(harness.send, benignPrompts, deadline))
  const results = await Promise.all(workers)

  await harness.teardown()

  // Aggregate
  const allLatencies = results.flatMap(r => r.latencies).sort((a, b) => a - b)
  const totalReqs   = results.reduce((s, r) => s + r.reqCount, 0)
  const totalFP     = results.reduce((s, r) => s + r.fpCount,  0)
  const totalErr    = results.reduce((s, r) => s + r.errCount, 0)
  const p50  = percentile(allLatencies, 50)
  const p95  = percentile(allLatencies, 95)
  const p99  = percentile(allLatencies, 99)
  const fpr  = totalReqs > 0 ? (totalFP / totalReqs) * 100 : 0
  const errRate = (totalReqs + totalErr) > 0
    ? (totalErr / (totalReqs + totalErr)) * 100
    : 0
  const rps = ((totalReqs / DURATION_MS) * 1000).toFixed(2)

  printTable('Results', [
    ['Total requests',        totalReqs],
    ['Throughput (RPS)',      rps],
    ['p50 latency',           fmtMs(p50)],
    ['p95 latency',           fmtMs(p95)],
    ['p99 latency',           fmtMs(p99)],
    ['False positives (FP)', totalFP],
    ['False positive rate',   `${fpr.toFixed(2)}%`],
    ['Errors',                totalErr],
    ['Error rate',            `${errRate.toFixed(2)}%`],
  ])

  // Assertions
  const failures: string[] = []
  if (totalFP > 0)
    failures.push(`FPR must be 0% — got ${totalFP} false positive(s) (${fpr.toFixed(2)}%)`)
  if (p99 > P99_THRESHOLD)
    failures.push(`p99 latency must be < ${P99_THRESHOLD}ms — got ${fmtMs(p99)}`)
  if (errRate > 1)
    failures.push(`Error rate must be < 1% — got ${errRate.toFixed(2)}%`)

  if (failures.length === 0) {
    console.log('\n✓ All thresholds met. Scenario A PASSED.\n')
    process.exit(0)
  } else {
    console.log('\n✗ Threshold violations:')
    for (const f of failures) console.log(`  • ${f}`)
    console.log('\nScenario A FAILED.\n')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
