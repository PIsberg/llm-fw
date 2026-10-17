import { createHash } from 'node:crypto'
import type { ToolResultShuntConfig } from '../../types.js'
import type { GatewayModuleContext } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { DEFAULT_CONFIG } from '../../config/config.js'
import { isLoopbackAddr } from '../../auth.js'
import { createLogger } from '../../logger.js'
import { SlotModule, type PayloadOutcome } from '../base.js'
import { collectTextSlots, type SlotKind, type TextSlot } from '../payload.js'
import { condense, renderCondensed, textSize, type WorkerProblem } from '../shuntWorker.js'
import { StoredOriginals, type StoredOutcome } from '../shuntStore.js'
import { RememberedCalls, toolArgs } from '../toolCalls.js'

const log = createLogger('tool-result-shunt')

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

const HOUR = 3_600_000

/** Why a tool result was forwarded whole, in the order data-model.md "Eligibility" decides them. */
export type WholeReason =
  | 'below-threshold'
  | 'excluded-tool'
  | 'tool-unknown'
  | 'too-large'
  | 'remote-client'
  | 'flagged'
  | 'worker-failed'
  | 'rejected'
  | 'store-failed'
  | 'store-full'

// A call with one of these arguments reads part of something, and a part is
// what the agent asked for: condensing it makes the agent read the rest back.
const RANGE_ARGS = ['offset', 'limit', 'view_range', 'head', 'tail', 'start_line', 'end_line'] as const

// The file name of a stored original: the SHA-256 of its text in hex, then
// `.txt`. A call that names one is the agent reading an original back.
const STORED_NAME = /(?<![\w-])[0-9a-f]{64}\.txt/i

/**
 * Steps 1 to 6 of data-model.md "Eligibility": the reason this result stays
 * whole, or null when it may be condensed. A tool is matched by its name or by
 * the name after `__`, as the truncator's `skipTools` is.
 */
export function eligibility(
  name: string | undefined,
  input: unknown,
  text: string,
  cfg: ToolResultShuntConfig,
  remoteAddress: string | undefined,
): WholeReason | null {
  if (name === undefined) return 'tool-unknown'
  if (!cfg.tools.some(tool => name === tool || name.endsWith(`__${tool}`))) return 'excluded-tool'
  const args = toolArgs(input)
  const raw = typeof input === 'string' ? input : JSON.stringify(input) ?? ''
  if (RANGE_ARGS.some(key => args?.[key] != null) || STORED_NAME.test(raw)) return 'excluded-tool'
  const { lines, chars } = textSize(text)
  if (lines < cfg.minLines && chars < cfg.minChars) return 'below-threshold'
  if (chars > cfg.maxInputChars) return 'too-large'
  if (!isLoopbackAddr(remoteAddress)) return 'remote-client'
  return null
}

/** What was decided for one result: the text that replaces it, or the reason it stays whole. */
type Decision = { condensed: string } | { whole: WholeReason }

/** The reasons an outcome file may name: the ones that are a decision, not a rule recomputed on every request. */
const DECIDED_WHOLE: ReadonlySet<string> = new Set<WholeReason>(['worker-failed', 'rejected', 'store-failed', 'store-full'])

/** A decided result, as remembered (data-model.md "Remembered outcome"). */
interface Remembered {
  decision: Decision
  /** When a request last carried the result; what the retention counts from. */
  carriedAt: number
  /** Whether the original and the outcome file are on disk, as a real request left them. A dry run leaves it false. */
  stored: boolean
}

/** One result to decide: the key it is remembered and stored under, the tool that made it and its exact text. */
interface Job { key: string; name: string; text: string }

const WORKER_PROBLEMS: Record<Exclude<WorkerProblem, 'partial-input'>, string> = {
  'no-worker': 'no worker is set up (modules.toolResultShunt.workerUrl and workerModel); large tool results are forwarded whole',
  'not-local': 'workerUrl does not name this machine (http or https to localhost, 127.x.x.x or ::1); nothing is sent to it and large tool results are forwarded whole',
  'error': 'the worker did not answer in time, or answered with an error or an unusable reply; the tool result is forwarded whole',
}

const STORE_PROBLEMS = {
  failed: 'a file could not be written to the folder of stored originals; the tool result is forwarded whole',
  unrestricted: 'access to the folder of stored originals cannot be limited to the running user, so nothing is stored; large tool results are forwarded whole',
  full: 'the folder of stored originals would pass modules.toolResultShunt.maxStoreMB; nothing is deleted to make room and large tool results are forwarded whole',
} as const

/**
 * Replaces a very large tool result with a short list of facts a local worker
 * model read from it, and keeps the original in a file the agent can open.
 *
 * Each result is decided once, the first time it is seen, and the decision is
 * remembered in memory and in an outcome file, so the same history comes out
 * byte-identical on every turn and after a restart. A result the worker did
 * not condense stays whole for good, and so does one whose original could not
 * be stored. It runs after detection and DLP (`afterScreening`), on the body
 * that would be forwarded.
 */
export class ToolResultShuntModule extends SlotModule<ToolResultShuntConfig> {
  readonly id = 'tool-result-shunt'
  readonly name = 'Tool Result Shunt'
  readonly description = 'Replaces an oversized tool result with facts a local worker model read from it, and stores the original in a file'
  protected readonly kinds = TOOL_OUTPUT

  /** Runs after detection and DLP, in `ModuleManager.transformScreened`, because it must know what they made of each result. */
  readonly afterScreening = true

  /** The folder of originals this module replaced, capped by `maxStoreMB` (read at each write, so a hot reload applies). */
  readonly store = new StoredOriginals(() => this.cfg.maxStoreMB * 1_048_576)

  // Tool calls learned from responses, for thread continuations that carry
  // results without their calls.
  private readonly calls = new RememberedCalls()
  // Result key to what was decided. No entry cap: dropping one would let the
  // result be decided again and come out differently. An entry nothing has
  // carried for `retentionHours` is dropped, as its files are swept.
  private readonly decided = new Map<string, Remembered>()
  // Results being decided now, so a request carrying one of them joins the
  // decision instead of asking the worker again.
  private readonly inflight = new Map<string, Promise<Remembered>>()
  // Problems already warned about; a problem is said once, never with text.
  private readonly warned = new Set<string>()
  private nextPrune = 0
  // The request `rewrite` is running for: SlotModule hands it only the slot.
  private current: GatewayModuleContext | undefined

  constructor(config?: ToolResultShuntConfig) {
    super(config ?? structuredClone(DEFAULT_CONFIG.modules!.toolResultShunt!))
  }

  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    this.calls.learn(response)
  }

  // The result is a job only when its call is known and `eligibility` passes.
  private job(slot: TextSlot, remoteAddress: string | undefined): Job | undefined {
    if (slot.kind !== 'tool_result') return undefined
    const learned = slot.toolName === undefined ? this.calls.get(slot.toolCallId) : undefined
    const name = slot.toolName ?? learned?.name
    if (eligibility(name, learned ? learned.input : slot.toolInput, slot.text, this.cfg, remoteAddress) !== null) return undefined
    const key = createHash('sha256').update(name!).update('\0').update(slot.text).digest('hex')
    return { key, name: name!, text: slot.text }
  }

  async prepare(payload: Record<string, unknown>, ctx: GatewayModuleContext): Promise<void> {
    const jobs = new Map<string, Job>()
    for (const slot of collectTextSlots(payload)) {
      const job = this.job(slot, ctx.remoteAddress)
      if (job) jobs.set(job.key, job)
    }
    if (jobs.size > 0) {
      // One wait limit for the whole request, however many results it carries.
      const deadline = Date.now() + this.cfg.waitMs
      await Promise.all([...jobs.values()].map(job => this.settle(job, ctx.dryRun === true, deadline)))
    }
    this.prune(Date.now())
  }

  /** Make sure the result has a decision, deciding it if no request has, and note that this request carries it. */
  private async settle(job: Job, dryRun: boolean, deadline: number): Promise<void> {
    let entry = this.decided.get(job.key)
    if (!entry) {
      let pending = this.inflight.get(job.key)
      if (!pending) {
        pending = this.decide(job, dryRun, deadline).finally(() => this.inflight.delete(job.key))
        this.inflight.set(job.key, pending)
      }
      entry = await pending
    }
    entry.carriedAt = Date.now()
    // Decided in a dry run, so nothing it points at is on disk yet.
    if (!entry.stored && !dryRun) await this.persist(job, entry, true)
  }

  private async decide(job: Job, dryRun: boolean, deadline: number): Promise<Remembered> {
    const saved = await this.store.readOutcome(job.key)
    const loaded = saved !== null && this.valid(saved, job.text)
    const entry: Remembered = { decision: loaded ? saved : await this.ask(job, deadline), carriedAt: Date.now(), stored: false }
    // Remembered only once its files are written, so no request forwards a
    // condensed result whose original is not there.
    if (!dryRun) await this.persist(job, entry, !loaded)
    this.decided.set(job.key, entry)
    return entry
  }

  /** An outcome read from disk is believed only when it is one this module would have written for this result. */
  private valid(saved: StoredOutcome, text: string): saved is Decision {
    if ('whole' in saved) return DECIDED_WHOLE.has(saved.whole)
    const header = renderCondensed(text, '', this.store.pathFor(text))
    return saved.condensed.length > header.length && saved.condensed.startsWith(header)
  }

  /** The worker's answer for one result, as a decision. */
  private async ask(job: Job, deadline: number): Promise<Decision> {
    const outcome = await condense(job.text, this.store.pathFor(job.text), { url: this.cfg.workerUrl, model: this.cfg.workerModel }, deadline)
    if ('text' in outcome) return { condensed: outcome.text }
    if (outcome.reason === 'rejected') return { whole: 'rejected' }
    if (outcome.problem === 'partial-input') {
      this.warnOnce('partial-input', `the worker read ${outcome.read ?? 0} of the ${outcome.sent ?? 0} tokens it was sent, so it answered from part of the output and the tool result is forwarded whole. Raise the worker's context window above ${outcome.sent ?? 0} tokens (for Ollama, num_ctx)`, { read: outcome.read, sent: outcome.sent })
    } else {
      this.warnOnce(outcome.problem, WORKER_PROBLEMS[outcome.problem])
    }
    return { whole: 'worker-failed' }
  }

  /**
   * Write the original of a condensed result, then its outcome file when
   * `writeOutcome` (or when the original could not be stored and the outcome
   * is now "whole"). A condensed result whose original is not on disk becomes
   * whole: the agent would be told to read a file that is not there.
   */
  private async persist(job: Job, entry: Remembered, writeOutcome: boolean): Promise<void> {
    let write = writeOutcome
    if ('condensed' in entry.decision) {
      const stored = await this.store.write(job.text)
      if (stored !== 'stored') {
        this.warnOnce(`store-${stored}`, STORE_PROBLEMS[stored], { file: 'original' })
        entry.decision = { whole: stored === 'full' ? 'store-full' : 'store-failed' }
        write = true
      }
    }
    if (write) {
      const stored = await this.store.writeOutcome(job.key, entry.decision)
      if (stored !== 'stored') this.warnOnce(`store-${stored}`, STORE_PROBLEMS[stored], { file: 'outcome' })
    }
    entry.stored = true
  }

  private warnOnce(problem: string, message: string, fields: Record<string, unknown> = {}): void {
    if (this.warned.has(problem)) return
    this.warned.add(problem)
    log.warn(message, { problem, ...fields })
  }

  /** At most once an hour, forget what no request has carried for `retentionHours` (its files are swept on the same clock). */
  private prune(now: number): void {
    if (now < this.nextPrune) return
    this.nextPrune = now + HOUR
    const retention = this.cfg.retentionHours * HOUR
    for (const [key, entry] of this.decided) if (now - entry.carriedAt > retention) this.decided.delete(key)
  }

  protected override apply(payload: Record<string, unknown>, ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome {
    this.current = ctx
    try {
      return super.apply(payload, ctx, estimates)
    } finally {
      this.current = undefined
    }
  }

  protected rewrite(text: string, slot: TextSlot): string {
    const job = this.job(slot, this.current?.remoteAddress)
    const decision = job && this.decided.get(job.key)?.decision
    return decision && 'condensed' in decision ? decision.condensed : text
  }
}
