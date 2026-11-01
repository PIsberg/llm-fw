/**
 * Load benchmark: throughput, latency, CPU and memory of the current tree,
 * swept over concurrency levels and workloads (npm run bench:load).
 *
 * Unlike scenario A (performance.ts), the firewall runs in a child process of
 * its own (lib/firewallProcess.ts) and reports its own CPU, memory and
 * event-loop delay over IPC, so the load generator's TLS work is not counted
 * against it. It reports and does not gate; charts come from
 * scripts/load-bench-charts.py.
 *
 * Env-var knobs:
 *   LOAD_BENCH_WORKLOADS    chat,agent,attack (default all three)
 *   LOAD_BENCH_CONCURRENCY  concurrency levels (default 1,2,4,8,16,32)
 *   LOAD_BENCH_STEP_S       measured seconds per level (default 10)
 *   LOAD_BENCH_WARMUP_S     unmeasured seconds before each level (default 2)
 *   LOAD_BENCH_AGENT_KB     size of an agent request in KB (default 64)
 *   LOAD_BENCH_OUT          output directory (default reports/load-bench/<timestamp>)
 *
 * Exit code: 0 = ran, 1 = the firewall process died or a level saw over 1% errors.
 */
import { fork, execFileSync, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createSender, startMockUpstream, printTable, fmtMs, type SendFn } from './lib/harness.js'
import {
  summarizeLatencies, cpuPctBetween, countStatuses, parseLevels, machineLoad, speedDrift,
  chatBody, agentBody, attackBody, type LatencySummary, type MachineLoad,
} from './lib/benchStats.js'
import type { Probe } from './lib/firewallProcess.js'
import { RULESET_VERSION } from '../../src/detection/ruleset.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '..', '..')

const WORKLOADS = (process.env.LOAD_BENCH_WORKLOADS ?? 'chat,agent,attack').split(',').map(s => s.trim()).filter(Boolean)
const LEVELS = parseLevels(process.env.LOAD_BENCH_CONCURRENCY, [1, 2, 4, 8, 16, 32])
const STEP_MS = Number(process.env.LOAD_BENCH_STEP_S ?? '10') * 1000
const WARMUP_MS = Number(process.env.LOAD_BENCH_WARMUP_S ?? '2') * 1000
const AGENT_KB = Number(process.env.LOAD_BENCH_AGENT_KB ?? '64')
const SAMPLE_MS = 500
const IDLE_MS = 3000
/** A level where other processes used this much of the machine is flagged. */
const OTHER_WARN_PCT = 10
/** A speed probe this much slower than the fastest flags throttling. */
const DRIFT_WARN_PCT = 20
const COLD_TIMEOUT_MS = 300_000
const PROXY_PORT = 19_380
const DASH_PORT = 19_931

const KNOWN = ['chat', 'agent', 'attack'] as const
type Workload = typeof KNOWN[number]
for (const w of WORKLOADS) {
  if (!(KNOWN as readonly string[]).includes(w)) throw new Error(`unknown workload "${w}"; expected ${KNOWN.join(', ')}`)
}

const DESCRIPTIONS: Record<Workload, string> = {
  chat: 'one short benign prompt, new text every request',
  agent: `a ${AGENT_KB} KB coding-agent request: resent history plus one new tool result`,
  attack: 'one attack prompt, which the firewall refuses',
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
const OUT_DIR = resolve(process.env.LOAD_BENCH_OUT ?? join(ROOT, 'reports', 'load-bench', stamp))

interface StepResult {
  workload: Workload
  concurrency: number
  durationS: number
  requests: number
  throughputRps: number
  latency: LatencySummary
  statuses: Record<string, number>
  /** Benign requests not answered 200, or attacks that were. */
  unexpected: number
  /** Indexes into benign.json (chat) or malicious.json (attack) behind `unexpected`. */
  unexpectedPrompts: number[]
  errors: number
  cpuPct: number
  cpuMsPerRequest: number
  peakRssMb: number
  meanRssMb: number
  peakHeapMb: number
  eventLoop: { p50Ms: number; p99Ms: number; maxMs: number }
  /** Machine-wide CPU while the level ran, as percentages of all threads. */
  machine: MachineLoad
  startWallMs: number
  endWallMs: number
  /** Every request's latency, ms, for the distribution charts. */
  latencies: number[]
}

function gitDescribe(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''
    return { commit, dirty }
  } catch {
    return { commit: 'unknown', dirty: false }
  }
}

class Firewall {
  private snapId = 0
  private waiting = new Map<number, (p: Probe) => void>()
  readonly timeline: Probe[] = []
  private exited: string | undefined

  private constructor(private child: ChildProcess) {
    child.on('message', (msg: { type: string; id?: number } & Probe) => {
      if (msg.type === 'sample') this.timeline.push(msg)
      else if (msg.type === 'snap' && msg.id !== undefined) {
        this.waiting.get(msg.id)?.(msg)
        this.waiting.delete(msg.id)
      }
    })
    child.on('exit', (code, signal) => { this.exited = `exited with ${signal ?? code}` })
  }

  static async start(upstreamCaPem: string): Promise<{ fw: Firewall; proxyCaPem: string; initMs: number; processReadyMs: number }> {
    const child = fork(join(__dir, 'lib', 'firewallProcess.ts'), [], {
      execArgv: ['--import', 'tsx/esm'],
      env: {
        ...process.env,
        LOAD_PROXY_PORT: String(PROXY_PORT),
        LOAD_DASH_PORT: String(DASH_PORT),
        LOAD_UPSTREAM_CA: upstreamCaPem,
        LOAD_SAMPLE_MS: String(SAMPLE_MS),
        // The child's LLM_FW_DIR is a temp dir, so without this every run
        // would download the model again. CI caches the same path.
        LLM_FW_MODEL_DIR: process.env.LLM_FW_MODEL_DIR || join(ROOT, '.hf-model-cache'),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    const ready = await new Promise<{ proxyCaPem: string; initMs: number; processReadyMs: number }>((res, rej) => {
      const timeout = setTimeout(() => rej(new Error('firewall process not ready after 300 s')), 300_000)
      child.on('message', (msg: { type: string; proxyCaPem: string; initMs: number; processReadyMs: number }) => {
        if (msg.type === 'ready') { clearTimeout(timeout); res(msg) }
      })
      child.once('exit', code => { clearTimeout(timeout); rej(new Error(`firewall process exited with ${code} before it was ready`)) })
    })
    return { fw: new Firewall(child), ...ready }
  }

  get pid(): number { return this.child.pid ?? 0 }

  snap(reset = false): Promise<Probe> {
    if (this.exited) return Promise.reject(new Error(`firewall process ${this.exited}`))
    const id = ++this.snapId
    return new Promise(res => {
      this.waiting.set(id, res)
      this.child.send({ type: 'snap', id, reset })
    })
  }

  alive(): void {
    if (this.exited) throw new Error(`firewall process ${this.exited}`)
  }

  async stop(): Promise<void> {
    if (this.exited) return
    const done = new Promise<void>(r => this.child.once('exit', () => r()))
    this.child.send({ type: 'stop' })
    await Promise.race([done, new Promise(r => setTimeout(r, 10_000))])
    if (!this.exited) this.child.kill()
  }
}

interface Hit { latencyMs: number; status: number; idx: number }

/**
 * A fixed single-thread CPU job (SHA-256 over 32 MB, best of three). Run
 * before each workload and at the end: if it slows down, the machine did
 * (thermal or power throttling), whatever the firewall was doing.
 */
const PROBE_BUF = Buffer.alloc(32 * 1024 * 1024, 7)
function speedProbeMs(): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    createHash('sha256').update(PROBE_BUF).digest()
    best = Math.min(best, performance.now() - t)
  }
  return Math.round(best * 10) / 10
}

let seq = 0
/** The body, and the index in the data file of the prompt it carries. */
function bodyFor(w: Workload, benign: string[], attacks: { prompt: string }[]): { body: string; idx: number } {
  const n = seq++
  if (w === 'chat') return { body: chatBody(benign, n), idx: n % benign.length }
  if (w === 'agent') return { body: agentBody(benign, n, AGENT_KB), idx: -1 }
  return { body: attackBody(attacks, n), idx: n % attacks.length }
}

async function drive(send: SendFn, w: Workload, vus: number, ms: number, benign: string[], attacks: { prompt: string }[]): Promise<{ hits: Hit[]; errors: number }> {
  const deadline = Date.now() + ms
  const hits: Hit[] = []
  let errors = 0
  await Promise.all(Array.from({ length: vus }, async () => {
    while (Date.now() < deadline) {
      try {
        const { body, idx } = bodyFor(w, benign, attacks)
        const { statusCode, latencyMs } = await send(body)
        hits.push({ latencyMs, status: statusCode, idx })
      } catch {
        errors++
      }
    }
  }))
  return { hits, errors }
}

async function main(): Promise<void> {
  const benign: string[] = JSON.parse(readFileSync(join(__dir, 'data', 'benign.json'), 'utf8'))
  const attacks: { prompt: string }[] = JSON.parse(readFileSync(join(__dir, 'data', 'malicious.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  const git = gitDescribe()
  const plannedS = Math.round((WORKLOADS.length * LEVELS.length * (STEP_MS + WARMUP_MS + 1000)) / 1000)

  console.log(`llm-fw ${pkg.version} (ruleset ${RULESET_VERSION}, ${git.commit}${git.dirty ? ', uncommitted changes' : ''})`)
  console.log(`Workloads ${WORKLOADS.join(', ')} | concurrency ${LEVELS.join(', ')} | ${STEP_MS / 1000} s per level after ${WARMUP_MS / 1000} s warm-up | about ${Math.ceil(plannedS / 60)} min`)
  console.log('Starting the firewall in its own process (loads the embedding model)...')

  const upstream = await startMockUpstream()
  const { fw, proxyCaPem, initMs, processReadyMs } = await Firewall.start(upstream.caPem)
  const send = createSender(PROXY_PORT, upstream.port, proxyCaPem)
  // One request per workload with no practical timeout, before any level:
  // the first agent request scans its whole history cold, and if a client
  // gives up on it the firewall still finishes it while every later request
  // misses the item cache too, so the run never reaches steady state.
  const sendCold = createSender(PROXY_PORT, upstream.port, proxyCaPem, COLD_TIMEOUT_MS)
  console.log(`Ready: pid ${fw.pid}, model and pipeline init ${fmtMs(initMs)}, process start to ready ${fmtMs(processReadyMs)}.\n`)

  const runStartWallMs = Date.now()
  let failed = false
  const steps: StepResult[] = []
  const speedProbes: { at: string; ms: number }[] = []
  const coldFirstRequestMs: Record<string, number> = {}
  try {
    // Idle baseline: the resident cost of an installed firewall doing nothing.
    const idle0 = await fw.snap(true)
    await new Promise(r => setTimeout(r, IDLE_MS))
    const idle1 = await fw.snap(true)
    const idle = { cpuPct: cpuPctBetween(idle0, idle1), rssMb: idle1.rssMb, heapUsedMb: idle1.heapUsedMb }
    console.log(`Idle: RSS ${idle.rssMb} MB, heap ${idle.heapUsedMb} MB, CPU ${idle.cpuPct}% of one core.\n`)

    for (const w of WORKLOADS as Workload[]) {
      speedProbes.push({ at: `before ${w}`, ms: speedProbeMs() })
      const cold = await sendCold(bodyFor(w, benign, attacks).body)
      coldFirstRequestMs[w] = Math.round(cold.latencyMs)
      console.log(`${w}: ${DESCRIPTIONS[w]} (speed probe ${speedProbes.at(-1)!.ms} ms, first request ${fmtMs(cold.latencyMs)}, status ${cold.statusCode})`)
      for (const vus of LEVELS) {
        if (WARMUP_MS > 0) await drive(send, w, vus, WARMUP_MS, benign, attacks)
        fw.alive()
        const a = await fw.snap(true)
        const cpus0 = os.cpus()
        const gen0 = process.cpuUsage()
        const genT0 = performance.now()
        const { hits, errors } = await drive(send, w, vus, STEP_MS, benign, attacks)
        const b = await fw.snap(true)
        const genWall = performance.now() - genT0
        const gen = process.cpuUsage(gen0)
        const generatorCpuPct = genWall > 0 ? ((gen.user + gen.system) / 1000 / genWall) * 100 : 0
        const durationS = (b.wallMs - a.wallMs) / 1000
        const inStep = fw.timeline.filter(p => p.wallMs > a.wallMs && p.wallMs <= b.wallMs)
        const probes = [a, ...inStep, b]
        const latencies = hits.map(h => h.latencyMs)
        const statuses = hits.map(h => h.status)
        const odd = hits.filter(h => (w === 'attack' ? h.status === 200 : h.status !== 200))
        const unexpected = odd.length
        const cpuMs = (b.cpuMicros - a.cpuMicros) / 1000
        const step: StepResult = {
          workload: w,
          concurrency: vus,
          durationS: Math.round(durationS * 100) / 100,
          requests: hits.length,
          throughputRps: Math.round((hits.length / durationS) * 100) / 100,
          latency: summarizeLatencies(latencies),
          statuses: countStatuses(statuses),
          unexpected,
          unexpectedPrompts: [...new Set(odd.map(h => h.idx).filter(i => i >= 0))].sort((x, y) => x - y),
          errors,
          cpuPct: cpuPctBetween(a, b),
          cpuMsPerRequest: hits.length > 0 ? Math.round((cpuMs / hits.length) * 100) / 100 : 0,
          peakRssMb: Math.max(...probes.map(p => p.rssMb)),
          meanRssMb: Math.round((probes.reduce((s, p) => s + p.rssMb, 0) / probes.length) * 10) / 10,
          peakHeapMb: Math.max(...probes.map(p => p.heapUsedMb)),
          eventLoop: { p50Ms: b.elP50Ms, p99Ms: b.elP99Ms, maxMs: b.elMaxMs },
          machine: machineLoad(cpus0, os.cpus(), cpuPctBetween(a, b), generatorCpuPct),
          startWallMs: a.wallMs,
          endWallMs: b.wallMs,
          latencies: latencies.map(l => Math.round(l * 10) / 10),
        }
        steps.push(step)
        const errRate = hits.length + errors > 0 ? errors / (hits.length + errors) : 0
        if (errRate > 0.01) failed = true
        console.log(
          `  ${String(vus).padStart(3)} VUs  ${String(step.throughputRps).padStart(7)} req/s  ` +
          `p50 ${fmtMs(step.latency.p50Ms).padStart(7)}  p99 ${fmtMs(step.latency.p99Ms).padStart(7)}  ` +
          `CPU ${String(step.cpuPct).padStart(6)}%  RSS ${step.peakRssMb} MB  loop p99 ${step.eventLoop.p99Ms} ms` +
          (errors ? `  errors ${errors}` : '') + (unexpected ? `  unexpected ${unexpected}` : '') +
          (step.machine.otherPct >= OTHER_WARN_PCT ? `  OTHER PROCESSES ${step.machine.otherPct}% of the machine` : ''),
        )
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    // After the load: does CPU fall back, and how much memory stays resident?
    const after0 = await fw.snap(true)
    await new Promise(r => setTimeout(r, IDLE_MS))
    const after1 = await fw.snap(true)
    const idleAfter = { cpuPct: cpuPctBetween(after0, after1), rssMb: after1.rssMb, heapUsedMb: after1.heapUsedMb }
    console.log(`\nIdle after load: RSS ${idleAfter.rssMb} MB, heap ${idleAfter.heapUsedMb} MB, CPU ${idleAfter.cpuPct}% of one core.`)

    speedProbes.push({ at: 'end', ms: speedProbeMs() })
    const drift = speedDrift(speedProbes.map(p => p.ms))
    const warnings: string[] = []
    const noisy = steps.filter(s => s.machine.otherPct >= OTHER_WARN_PCT)
    if (noisy.length > 0) {
      const worst = noisy.reduce((m, s) => (s.machine.otherPct > m.machine.otherPct ? s : m))
      warnings.push(`other processes used ${OTHER_WARN_PCT}% or more of the machine in ${noisy.length} of ${steps.length} levels (worst ${worst.machine.otherPct}%, ${worst.workload} at ${worst.concurrency})`)
    }
    if (drift >= DRIFT_WARN_PCT) {
      warnings.push(`the CPU speed probe varied by ${drift}% over the run (${speedProbes.map(p => `${p.ms} ms ${p.at}`).join(', ')}): the machine slowed down`)
    }
    for (const w of warnings) console.log(`WARNING: ${w}. Treat this run as noisy and run it again on a quiet machine.`)

    const output = {
      kind: 'llm-fw-load-benchmark',
      schema: 1,
      meta: {
        version: pkg.version,
        ruleset: RULESET_VERSION,
        commit: git.commit,
        dirty: git.dirty,
        timestamp: new Date(runStartWallMs).toISOString(),
        node: process.version,
        platform: `${os.type()} ${os.release()} ${os.arch()}`,
        cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
        cores: os.availableParallelism(),
        totalMemGb: Math.round(os.totalmem() / 1024 ** 3),
      },
      config: { workloads: WORKLOADS, concurrency: LEVELS, stepS: STEP_MS / 1000, warmupS: WARMUP_MS / 1000, agentKb: AGENT_KB, sampleMs: SAMPLE_MS },
      descriptions: Object.fromEntries(WORKLOADS.map(w => [w, DESCRIPTIONS[w as Workload]])),
      startup: { initMs, processReadyMs, idle, idleAfter },
      speedProbes,
      coldFirstRequestMs,
      warnings,
      steps,
      timeline: fw.timeline.map(p => ({
        t: Math.round((p.wallMs - runStartWallMs) / 100) / 10,
        rssMb: p.rssMb,
        heapUsedMb: p.heapUsedMb,
        externalMb: p.externalMb,
        elP99Ms: p.elP99Ms,
      })),
      timelineCpu: fw.timeline.slice(1).map((p, i) => ({
        t: Math.round((p.wallMs - runStartWallMs) / 100) / 10,
        cpuPct: cpuPctBetween(fw.timeline[i]!, p),
      })),
      runStartWallMs,
    }
    mkdirSync(OUT_DIR, { recursive: true })
    const file = join(OUT_DIR, 'results.json')
    writeFileSync(file, JSON.stringify(output, null, 2))

    const best = (w: string) => steps.filter(s => s.workload === w).reduce((m, s) => (s.throughputRps > m.throughputRps ? s : m))
    printTable('Peak throughput per workload', WORKLOADS.map(w => {
      const s = best(w)
      return [w, `${s.throughputRps} req/s at ${s.concurrency} VUs, p99 ${fmtMs(s.latency.p99Ms)}, CPU ${s.cpuPct}%, ${s.cpuMsPerRequest} ms CPU/req`] as [string, string]
    }))
    console.log(`\nPeak RSS over the run: ${Math.max(...steps.map(s => s.peakRssMb))} MB (idle ${idle.rssMb} MB).`)
    console.log(`Results written to ${file}`)
    console.log(`Charts: python scripts/load-bench-charts.py "${file}"`)
  } catch (err) {
    console.error('Benchmark failed:', err)
    failed = true
  } finally {
    await fw.stop()
    await upstream.close()
  }
  process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
