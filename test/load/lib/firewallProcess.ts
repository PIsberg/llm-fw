/**
 * The firewall under test, in a process of its own (child of
 * test/load/benchmark.ts). Running it apart from the load generator is the
 * point: the CPU and memory it reports are the proxy's alone, not the proxy
 * plus the TLS clients hammering it, which is what scenario A measures.
 *
 * Env: LOAD_PROXY_PORT, LOAD_DASH_PORT, LOAD_UPSTREAM_CA (PEM of the mock
 * upstream's CA, which the proxy's outbound leg must trust), LOAD_SAMPLE_MS,
 * LOAD_BENCH_DETECTION (JSON merged over config.detection, to compare settings).
 *
 * IPC, child to parent:
 *   { type: 'ready', proxyCaPem, initMs, processReadyMs }
 *   { type: 'sample', ...Probe }          every LOAD_SAMPLE_MS
 *   { type: 'snap', id, ...Probe }        in answer to { type: 'snap', id }
 * Parent to child: { type: 'snap', id, reset? } and { type: 'stop' }.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
// Importing the harness also points UpstreamResolver at 127.0.0.1.
import { loadTestConfig } from './harness.js'
import { trustCA } from '../../proxy/lib/tls-trust.js'
import { ProxyServer } from '../../../src/proxy/proxy.js'
import { EventBus } from '../../../src/dashboard/eventBus.js'
import { CertFactory } from '../../../src/proxy/certs.js'

export interface Probe {
  /** Wall clock, ms since the epoch, so the parent can line samples up with steps. */
  wallMs: number
  /** Cumulative user plus system CPU of the whole process, every thread. */
  cpuMicros: number
  rssMb: number
  heapUsedMb: number
  externalMb: number
  /** Event-loop delay since the last reset of this histogram, ms. */
  elP50Ms: number
  elP99Ms: number
  elMaxMs: number
}

const MB = 1024 * 1024
const r1 = (n: number): number => Math.round(n * 10) / 10
const ns2ms = (ns: number): number => Math.round((ns / 1e6) * 100) / 100

function probe(h: ReturnType<typeof monitorEventLoopDelay>): Probe {
  const cpu = process.cpuUsage()
  const mem = process.memoryUsage()
  return {
    wallMs: Date.now(),
    cpuMicros: cpu.user + cpu.system,
    rssMb: r1(mem.rss / MB),
    heapUsedMb: r1(mem.heapUsed / MB),
    externalMb: r1(mem.external / MB),
    elP50Ms: h.count > 0 ? ns2ms(h.percentile(50)) : 0,
    elP99Ms: h.count > 0 ? ns2ms(h.percentile(99)) : 0,
    elMaxMs: h.count > 0 ? ns2ms(h.max) : 0,
  }
}

async function main(): Promise<void> {
  if (!process.send) throw new Error('firewallProcess must be started with an IPC channel (child_process.fork)')
  const send = process.send.bind(process)
  const proxyPort = Number(process.env.LOAD_PROXY_PORT)
  const dashPort = Number(process.env.LOAD_DASH_PORT)
  const upstreamCa = process.env.LOAD_UPSTREAM_CA ?? ''
  const sampleMs = Number(process.env.LOAD_SAMPLE_MS ?? '500')
  if (!proxyPort || !dashPort || !upstreamCa) throw new Error('LOAD_PROXY_PORT, LOAD_DASH_PORT and LOAD_UPSTREAM_CA are required')

  const tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-bench-'))
  process.env.LLM_FW_DIR = tempDir
  const proxyCaPem = new CertFactory().generateCA().cert
  const restoreTrust = trustCA(upstreamCa)

  const config = loadTestConfig(proxyPort, dashPort)
  Object.assign(config.detection, JSON.parse(process.env.LOAD_BENCH_DETECTION ?? '{}'))
  const proxy = new ProxyServer(config, new EventBus(config.dashboard))
  const t0 = performance.now()
  await proxy.init() // loads the embedding model
  const initMs = Math.round(performance.now() - t0)
  proxy.start()

  // One histogram for the timeline, one per measured step.
  const timelineHist = monitorEventLoopDelay({ resolution: 10 })
  const stepHist = monitorEventLoopDelay({ resolution: 10 })
  timelineHist.enable()
  stepHist.enable()

  const timer = setInterval(() => {
    send({ type: 'sample', ...probe(timelineHist) })
    timelineHist.reset()
  }, sampleMs)

  process.on('message', async (msg: { type: string; id?: number; reset?: boolean }) => {
    if (msg.type === 'snap') {
      send({ type: 'snap', id: msg.id, ...probe(stepHist) })
      if (msg.reset) stepHist.reset()
    } else if (msg.type === 'stop') {
      clearInterval(timer)
      restoreTrust()
      await proxy.stop()
      try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
      process.disconnect()
      process.exit(0)
    }
  })

  send({ type: 'ready', proxyCaPem, initMs, processReadyMs: Math.round(performance.now()) })
}

main().catch(err => {
  console.error('firewall process failed:', err)
  process.exit(1)
})
