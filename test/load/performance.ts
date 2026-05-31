/**
 * Scenario A — Pure Performance (Benign Stress Test)
 *
 * Env-var knobs:
 *   LOAD_VUS          concurrent workers  (default: 5)
 *   LOAD_DURATION_S   duration in seconds (default: 20)
 *   LOAD_P99_MS       p99 ceiling in ms   (default: 5000)
 *   LOAD_OUTPUT_FILE  path to write JSON results (optional)
 *
 * Exit code: 0 = pass, 1 = threshold violated.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { setupHarness, percentile, printTable, fmtMs, type SendFn } from './lib/harness.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const VUS           = parseInt(process.env.LOAD_VUS        ?? '5',    10)
const DURATION_MS   = parseInt(process.env.LOAD_DURATION_S ?? '20',   10) * 1000
const P99_THRESHOLD = parseInt(process.env.LOAD_P99_MS     ?? '5000', 10)
const OUTPUT_FILE   = process.env.LOAD_OUTPUT_FILE ?? ''

const PROXY_PORT = 19_180
const DASH_PORT  = 19_731

interface Sample { startMs: number; latencyMs: number; fp: boolean }

interface WorkerResult {
  samples: Sample[]
  errCount: number
}

async function runWorker(send: SendFn, prompts: string[], deadline: number): Promise<WorkerResult> {
  const samples: Sample[] = []
  let errCount = 0

  while (Date.now() < deadline) {
    const prompt = prompts[Math.floor(Math.random() * prompts.length)]!
    const body = JSON.stringify({
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
    })
    const startMs = Date.now()
    try {
      const { statusCode, latencyMs } = await send(body)
      samples.push({ startMs, latencyMs, fp: statusCode === 403 })
    } catch {
      errCount++
    }
  }

  return { samples, errCount }
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

  const testStart = Date.now()
  const deadline  = testStart + DURATION_MS
  const workers   = Array.from({ length: VUS }, () => runWorker(harness.send, benignPrompts, deadline))
  const results   = await Promise.all(workers)

  await harness.teardown()

  // Aggregate
  const allSamples  = results.flatMap(r => r.samples)
  const allLatencies = allSamples.map(s => s.latencyMs).sort((a, b) => a - b)
  const totalReqs   = allSamples.length
  const totalFP     = allSamples.filter(s => s.fp).length
  const totalErr    = results.reduce((s, r) => s + r.errCount, 0)
  const p50  = percentile(allLatencies, 50)
  const p95  = percentile(allLatencies, 95)
  const p99  = percentile(allLatencies, 99)
  const fpr  = totalReqs > 0 ? (totalFP / totalReqs) * 100 : 0
  const errRate = (totalReqs + totalErr) > 0 ? (totalErr / (totalReqs + totalErr)) * 100 : 0
  const rps = parseFloat(((totalReqs / DURATION_MS) * 1000).toFixed(2))

  // Build per-second time series
  const durationS = Math.ceil(DURATION_MS / 1000)
  const timeSeries = Array.from({ length: durationS }, (_, i) => {
    const bucketStart = testStart + i * 1000
    const bucketEnd   = bucketStart + 1000
    const inBucket = allSamples
      .filter(s => s.startMs >= bucketStart && s.startMs < bucketEnd)
      .map(s => s.latencyMs)
      .sort((a, b) => a - b)
    return {
      second: i + 1,
      rps: inBucket.length,
      p50Ms: percentile(inBucket, 50),
      p95Ms: percentile(inBucket, 95),
    }
  })

  printTable('Results', [
    ['Total requests',       totalReqs],
    ['Throughput (RPS)',     rps],
    ['p50 latency',          fmtMs(p50)],
    ['p95 latency',          fmtMs(p95)],
    ['p99 latency',          fmtMs(p99)],
    ['False positives (FP)', totalFP],
    ['False positive rate',  `${fpr.toFixed(2)}%`],
    ['Errors',               totalErr],
    ['Error rate',           `${errRate.toFixed(2)}%`],
  ])

  // Assertions
  const failures: string[] = []
  if (totalFP > 0)
    failures.push(`FPR must be 0% — got ${totalFP} false positive(s) (${fpr.toFixed(2)}%)`)
  if (p99 > P99_THRESHOLD)
    failures.push(`p99 latency must be < ${P99_THRESHOLD}ms — got ${fmtMs(p99)}`)
  if (errRate > 1)
    failures.push(`Error rate must be < 1% — got ${errRate.toFixed(2)}%`)

  const passed = failures.length === 0

  // JSON output
  if (OUTPUT_FILE) {
    const output = {
      scenario: 'performance' as const,
      timestamp: new Date().toISOString(),
      config: { vus: VUS, durationS: DURATION_MS / 1000, p99ThresholdMs: P99_THRESHOLD },
      results: {
        totalRequests: totalReqs,
        throughputRps: rps,
        latencyPercentiles: { p50, p95, p99 },
        falsePositives: totalFP,
        fpr: parseFloat(fpr.toFixed(4)),
        errors: totalErr,
        errRate: parseFloat(errRate.toFixed(4)),
        timeSeries,
      },
      passed,
      failures,
    }
    mkdirSync(join(OUTPUT_FILE, '..'), { recursive: true })
    writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2))
    console.log(`\nResults written → ${OUTPUT_FILE}`)
  }

  if (passed) {
    console.log('\n✓ All thresholds met. Scenario A PASSED.\n')
    process.exit(0)
  } else {
    console.log('\n✗ Threshold violations:')
    for (const f of failures) console.log(`  • ${f}`)
    console.log('\nScenario A FAILED.\n')
    process.exit(1)
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
