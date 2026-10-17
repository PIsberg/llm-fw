import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { LeanCtxConfig } from '../../types.js'
import type { GatewayModuleContext } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { DEFAULT_CONFIG } from '../../config/config.js'
import { getLlmFwDir } from '../../config/paths.js'
import { createLogger } from '../../logger.js'
import { SlotModule } from '../base.js'
import { collectTextSlots, type SlotKind, type TextSlot } from '../payload.js'
import { RememberedCalls, toolArgs } from '../toolCalls.js'

const log = createLogger('lean-ctx')

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

/** child_process.spawn, or a stand-in for it in tests. */
export type LeanCtxSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

/**
 * True when a word of `command` is one of `skipCommands`, compared by its
 * basename without `.exe`; an entry with a hyphen (a PowerShell cmdlet such
 * as Get-Content) matches in any case. Any word counts, a pipeline stage or
 * an argument alike, so a doubtful command is treated as a file read.
 */
export function isFileRead(command: string, skipCommands: readonly string[]): boolean {
  for (const word of command.split(/[\s;&|()<>`$"'{}]+/)) {
    const base = (word.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')
    if (!base) continue
    if (skipCommands.some(skip => skip === base || (skip.includes('-') && skip.toLowerCase() === base.toLowerCase()))) return true
  }
  return false
}

// lean-ctx appends one of these to a lossy result: an instruction to fetch
// the original through a retrieve tool or from a file on this machine. No
// such tool exists behind llm-fw, and llm-fw would be writing an
// instruction into a tool result its own detectors then scan.
const RETRIEVE_LINE = /\n\[lean-ctx( CCR)?: [^\n]*\]\s*$/
function withoutRetrieve(text: string): string {
  let out = text
  while (RETRIEVE_LINE.test(out)) out = out.replace(RETRIEVE_LINE, '')
  return out
}

// The environment lean-ctx runs in: enough to start a process, none of
// llm-fw's own (provider keys, LLM_FW_*). lean-ctx snapshots its environment
// into its state folder.
const PASSED_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'])

// Measured on 30 days of Claude Code traffic: p50 5.6 ms, p99 55 ms a call.
const CONCURRENCY = 8
const STARTUP_MS = 10_000
const RETRY_MS = 60_000
const MAX_REMEMBERED = 4096

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/** Resolves to the promise's value, or to `fallback` once `deadline` passes. */
async function by<T>(promise: Promise<T>, deadline: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now())) })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

/** A private `lean-ctx proxy` on a loopback port, used only for POST /v1/compress. */
class Sidecar {
  alive = true
  readonly ready: Promise<boolean>
  private readonly child: ChildProcess
  private readonly url: string
  private readonly token: string
  private readonly onExit = (): void => { this.child.kill() }

  private constructor(launch: LeanCtxSpawn, binary: string, port: number, onStop: (reason: string, detail: Record<string, string>) => void) {
    this.url = `http://127.0.0.1:${port}`
    this.token = randomBytes(24).toString('hex')

    // Resolved per start, never at import: tests and `llm-fw --dir` move it.
    const home = join(getLlmFwDir(), 'lean-ctx')
    const dirs = {
      LEAN_CTX_DATA_DIR: join(home, 'data'),
      LEAN_CTX_CONFIG_DIR: join(home, 'config'),
      LEAN_CTX_STATE_DIR: join(home, 'state'),
      LEAN_CTX_CACHE_DIR: join(home, 'cache'),
    }
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // lean-ctx writes the original of every lossy result to <state>/tee/ and
    // skips the write when it cannot create that folder (proxy/ccr.rs,
    // ccr/storage.rs). A file in its place keeps tool output off disk.
    const tee = join(dirs.LEAN_CTX_STATE_DIR, 'tee')
    if (fs.existsSync(tee) && fs.statSync(tee).isDirectory()) fs.rmSync(tee, { recursive: true, force: true })
    if (!fs.existsSync(tee)) fs.writeFileSync(tee, 'llm-fw: lean-ctx keeps no copies of tool output here\n')

    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) if (PASSED_ENV.has(key.toUpperCase())) env[key] = value
    Object.assign(env, dirs, { DO_NOT_TRACK: '1', LEAN_CTX_TELEMETRY: 'off', LEAN_CTX_PROXY_TOKEN: this.token })

    let stderr = ''
    this.child = launch(binary, ['proxy', 'start', `--port=${port}`], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    this.child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048) })
    process.once('exit', this.onExit)
    const exited = new Promise<boolean>(resolve => {
      const done = (reason: string): void => {
        if (this.alive) onStop(reason, { binary, stderr: stderr.trim() })
        this.alive = false
        process.removeListener('exit', this.onExit)
        resolve(false)
      }
      this.child.once('error', err => done(err.message))
      this.child.once('exit', code => done(`exit ${String(code)}`))
    })
    this.ready = Promise.race([exited, this.healthy(Date.now() + STARTUP_MS)])
  }

  static async start(launch: LeanCtxSpawn, onStop: (reason: string, detail: Record<string, string>) => void): Promise<Sidecar> {
    // From the process environment only, like LLM_FW_DIR: a project config
    // file comes with whatever repository llm-fw is started in, and must not
    // choose a program for it to run.
    const binary = process.env.LLM_FW_LEAN_CTX_BIN || 'lean-ctx'
    return new Sidecar(launch, binary, await freePort(), onStop)
  }

  private async healthy(deadline: number): Promise<boolean> {
    while (this.alive && Date.now() < deadline) {
      try {
        const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) return true
      } catch {
        // not listening yet
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return false
  }

  /** lean-ctx's output for one tool result, or null when it gave none in time. */
  async compress(name: string, text: string, deadline: number): Promise<string | null> {
    try {
      const res = await fetch(`${this.url}/v1/compress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        // One result per call and no model: lean-ctx rewrites only the last
        // three messages of a conversation, and picks its tokenizer by model,
        // so either would make the output depend on more than this result.
        body: JSON.stringify({ messages: [{ role: 'tool', name, content: text }] }),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })
      if (!res.ok) return null
      const body = await res.json() as { messages?: Array<{ content?: unknown }> }
      const out = body.messages?.[0]?.content
      if (typeof out !== 'string') return null
      const kept = withoutRetrieve(out)
      return kept.trim() || !text.trim() ? kept : null
    } catch {
      return null
    }
  }

  close(): void {
    this.alive = false
    process.removeListener('exit', this.onExit)
    this.child.kill()
  }
}

interface Job { key: string; name: string; text: string }

/**
 * Compresses the output of shell commands through lean-ctx
 * (github.com/yvgude/lean-ctx), run as a private `lean-ctx proxy` on a
 * loopback port. Lossy: lean-ctx keeps the lines it ranks highest and says
 * how many it dropped.
 *
 * Only the results of the shell tools in `tools`, and only when the command
 * is known and is not a file read (`skipCommands`). Measured on 30 days of
 * Claude Code traffic, lean-ctx's cuts to file reads (Read, cat, sed -n) were
 * 16.2 of its 18.6 points of saving, and cutting file reads made the agent
 * read them back (see the truncator).
 *
 * Each result's output is decided the first time it is seen and remembered,
 * so the same history comes out byte-identical on every turn. A result that
 * lean-ctx did not answer within `timeoutMs` stays whole for good.
 */
export class LeanCtxModule extends SlotModule<LeanCtxConfig> {
  readonly id = 'lean-ctx'
  readonly name = 'lean-ctx Shell Output Compressor'
  readonly description = 'Compresses shell command output, file reads aside, through a private lean-ctx process'
  protected readonly kinds = TOOL_OUTPUT

  private readonly calls = new RememberedCalls()
  // Job key to lean-ctx's output, or null for "forward as is", oldest first.
  private readonly decided = new Map<string, string | null>()
  private sidecar: Promise<Sidecar | null> | null = null
  private retryAt = 0
  // The last reason lean-ctx stopped, logged once rather than on every
  // retry: without lean-ctx installed, a start is tried once a minute.
  private lastStop = ''
  private readonly launch: LeanCtxSpawn

  constructor(config?: LeanCtxConfig, launch: LeanCtxSpawn = spawn) {
    super(config ?? structuredClone(DEFAULT_CONFIG.modules!.leanCtx!))
    this.launch = launch
  }

  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    this.calls.learn(response)
  }

  // A result is a job only when its tool is a shell and its command is
  // known: from the call in the request, or from a response seen here.
  private job(slot: TextSlot): Job | undefined {
    if (slot.kind !== 'tool_result') return undefined
    const learned = slot.toolName === undefined ? this.calls.get(slot.toolCallId) : undefined
    const name = slot.toolName ?? learned?.name
    if (name === undefined || !this.cfg.tools.some(tool => name === tool || name.endsWith(`__${tool}`))) return undefined
    const command = toolArgs(learned ? learned.input : slot.toolInput)?.command
    if (typeof command !== 'string' || isFileRead(command, this.cfg.skipCommands)) return undefined
    const key = createHash('sha256').update(name).update('\0').update(slot.text).digest('hex')
    return { key, name, text: slot.text }
  }

  private remember(key: string, out: string | null): void {
    this.decided.delete(key)
    this.decided.set(key, out)
    if (this.decided.size > MAX_REMEMBERED) this.decided.delete(this.decided.keys().next().value!)
  }

  private async client(deadline: number): Promise<Sidecar | null> {
    const pending = this.sidecar
    const sidecar = pending ? await pending : null
    if (sidecar?.alive) {
      if (!await by(sidecar.ready, deadline, false)) return null
      this.lastStop = ''
      return sidecar
    }
    // Another request replaced it while this one waited: use that one.
    if (this.sidecar !== pending) return this.client(deadline)
    // Never started, failed to start, or stopped since: start one, at most
    // once per RETRY_MS. Assigned before any await, so concurrent requests
    // share the one start.
    if (Date.now() < this.retryAt) return null
    this.retryAt = Date.now() + RETRY_MS
    const onStop = (reason: string, detail: Record<string, string>): void => {
      if (reason === this.lastStop) return
      this.lastStop = reason
      log.warn('lean-ctx stopped; shell output is forwarded as is', { reason, ...detail })
    }
    this.sidecar = Sidecar.start(this.launch, onStop).catch((err: unknown) => {
      onStop(String(err), {})
      return null
    })
    return this.client(deadline)
  }

  async prepare(payload: Record<string, unknown>): Promise<void> {
    const jobs = new Map<string, Job>()
    for (const slot of collectTextSlots(payload)) {
      const job = this.job(slot)
      if (job && !this.decided.has(job.key)) jobs.set(job.key, job)
    }
    if (jobs.size === 0) return
    const deadline = Date.now() + this.cfg.timeoutMs
    const sidecar = await this.client(deadline)
    const pending = [...jobs.values()]
    const answers = new Map<string, string | null>()
    if (sidecar) {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
        for (let job = pending.pop(); job; job = pending.pop()) {
          answers.set(job.key, await sidecar.compress(job.name, job.text, deadline))
        }
      }))
    }
    for (const key of jobs.keys()) this.remember(key, answers.get(key) ?? null)
  }

  protected rewrite(text: string, slot: TextSlot): string {
    const job = this.job(slot)
    return (job && this.decided.get(job.key)) ?? text
  }

  /** Stops lean-ctx. It is started again by the next request that needs it. */
  close(): void {
    void this.sidecar?.then(sidecar => sidecar?.close())
    this.sidecar = null
    this.retryAt = 0
  }
}
