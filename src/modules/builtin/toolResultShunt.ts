import { createHash } from 'node:crypto'
import type { ToolResultShuntConfig } from '../../types.js'
import type { GatewayModuleContext, ModuleStats } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { DEFAULT_CONFIG } from '../../config/config.js'
import { isLoopbackAddr } from '../../auth.js'
import { createLogger } from '../../logger.js'
import { SlotModule, estimate, type PayloadOutcome } from '../base.js'
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

/** A count for every reason, in the order the card lists them. */
const noReasons = (): Record<WholeReason, number> => ({
  'below-threshold': 0,
  'excluded-tool': 0,
  'tool-unknown': 0,
  'too-large': 0,
  'remote-client': 0,
  'flagged': 0,
  'worker-failed': 0,
  'rejected': 0,
  'store-failed': 0,
  'store-full': 0,
})

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
const DECIDED_WHOLE: ReadonlySet<string> = new Set<WholeReason>(['flagged', 'worker-failed', 'rejected', 'store-failed', 'store-full'])

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

/**
 * A result of the request being prepared, with what the screening record says
 * of it. `flagged`: a scan, the MCP audit or DLP flagged it. `untrusted`: the
 * record cannot vouch for it (no record, an incomplete scan, one cut short
 * before it); that is not a flag, so a decision already made stands.
 */
interface Pending extends Job { flagged: boolean; untrusted: boolean }

const isFlagged = (entry: Remembered | undefined): boolean =>
  entry !== undefined && 'whole' in entry.decision && entry.decision.whole === 'flagged'

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
 * that would be forwarded, and reads `ctx.screening` to leave whole what they
 * flagged or did not scan: a new result nothing vouches for is never sent to
 * the worker, and one condensed earlier goes whole, for good, from the first
 * request on which its own slot is flagged (its stored original is deleted).
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
  // carried for `retentionHours` is dropped, as its files are swept; a
  // flagged one is not, so a result detection flagged is not asked about
  // once its entry lapses.
  private readonly decided = new Map<string, Remembered>()
  // Results being decided now, so a request carrying one of them joins the
  // decision instead of asking the worker again.
  private readonly inflight = new Map<string, Promise<Remembered>>()
  // Each key's disk writes, one after another (see onDisk).
  private readonly diskChain = new Map<string, Promise<void>>()
  // Problems already warned about; a problem is said once, never with text.
  private readonly warned = new Set<string>()
  private nextPrune = 0
  // The request `rewrite` is running for: SlotModule hands it only the slot.
  private current: GatewayModuleContext | undefined
  private estimates: Map<string, number> | undefined

  // The card (data-model.md "Counters"). Results are counted once per request
  // that carries them, worker tokens once per worker call; none of it holds
  // text. Not reset: the folder's totals come from `store.stats()`.
  private condensedCount = 0
  private wholeCount = noReasons()
  private originalTokens = 0
  private condensedTokens = 0
  private workerIn = 0
  private workerOut = 0
  private waitSamples = 0
  private waitTotalMs = 0
  private waitMaxMs = 0

  constructor(config?: ToolResultShuntConfig) {
    super(config ?? structuredClone(DEFAULT_CONFIG.modules!.toolResultShunt!))
  }

  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    this.calls.learn(response)
  }

  // The result is a job only when its call is known and `eligibility` passes;
  // otherwise `eligibility` names the reason it stays whole.
  private classify(slot: TextSlot, remoteAddress: string | undefined): { job: Job } | { whole: WholeReason } | undefined {
    if (slot.kind !== 'tool_result') return undefined
    const learned = slot.toolName === undefined ? this.calls.get(slot.toolCallId) : undefined
    const name = slot.toolName ?? learned?.name
    const whole = eligibility(name, learned ? learned.input : slot.toolInput, slot.text, this.cfg, remoteAddress)
    if (whole !== null) return { whole }
    const key = createHash('sha256').update(name!).update('\0').update(slot.text).digest('hex')
    return { job: { key, name: name!, text: slot.text } }
  }

  private job(slot: TextSlot, remoteAddress: string | undefined): Job | undefined {
    const found = this.classify(slot, remoteAddress)
    return found && 'job' in found ? found.job : undefined
  }

  async prepare(payload: Record<string, unknown>, ctx: GatewayModuleContext): Promise<void> {
    const slots = collectTextSlots(payload)
    const found: Array<{ index: number; job: Job }> = []
    slots.forEach((slot, index) => {
      const job = this.job(slot, ctx.remoteAddress)
      if (job) found.push({ index, job })
    })
    if (found.length > 0) {
      // What detection and DLP made of each result, read once per request.
      const screened = ctx.screening?.flaggedSlots(slots)
      const jobs = new Map<string, Pending>()
      for (const { index, job } of found) {
        const seen = jobs.get(job.key)
        jobs.set(job.key, {
          ...job,
          flagged: seen?.flagged === true || screened?.flagged.has(index) === true,
          untrusted: seen?.untrusted === true || screened === undefined || screened.all || screened.unreached.has(index),
        })
      }
      // One wait limit for the whole request, however many results it carries.
      const started = performance.now()
      const deadline = Date.now() + this.cfg.waitMs
      const waited = await Promise.all([...jobs.values()].map(job => this.settle(job, ctx.dryRun === true, deadline)))
      // A request that only read decisions already made waited for nothing and is no sample.
      if (waited.some(Boolean)) this.sampleWait(Math.round(performance.now() - started))
    }
    this.prune(Date.now())
  }

  /**
   * Make sure the result has a decision, deciding it if no request has, and
   * note that this request carries it. A result flagged on this request goes
   * whole whatever state it is in: an earlier condensation, or a decision
   * another request is still making. Resolves to whether this request had to
   * wait for the worker or the disk.
   */
  private async settle(job: Pending, dryRun: boolean, deadline: number): Promise<boolean> {
    let waited = false
    let entry = this.decided.get(job.key)
    if (job.flagged && !isFlagged(entry) && (!entry || 'condensed' in entry.decision)) {
      // Flagged in memory at once, so nothing decided or written from here on
      // treats it as condensed. Its files follow below, behind the key's pending writes.
      if (entry) {
        entry.decision = { whole: 'flagged' }
        entry.stored = false
      } else {
        entry = { decision: { whole: 'flagged' }, carriedAt: Date.now(), stored: false }
        this.decided.set(job.key, entry)
      }
    } else if (!entry) {
      let pending = this.inflight.get(job.key)
      if (!pending) {
        pending = this.decide(job, dryRun, deadline).finally(() => this.inflight.delete(job.key))
        this.inflight.set(job.key, pending)
      }
      entry = await pending
      waited = true
    }
    entry.carriedAt = Date.now()
    // Decided or flagged in a dry run, so what it points at is not on disk yet.
    if (!entry.stored && !dryRun) {
      await this.persist(job, entry, true)
      waited = true
    }
    return waited
  }

  private async decide(job: Pending, dryRun: boolean, deadline: number): Promise<Remembered> {
    const saved = await this.store.readOutcome(job.key)
    const loaded = saved !== null && this.valid(saved, job.text)
    // A result nothing vouches for never goes to the worker. One a restart
    // finds an outcome file for keeps what that file says.
    const decision: Decision = loaded ? saved : job.untrusted ? { whole: 'flagged' } : await this.ask(job, deadline)
    const entry: Remembered = { decision, carriedAt: Date.now(), stored: false }
    // Remembered only once its files are written, so no request forwards a
    // condensed result whose original is not there.
    if (!dryRun) await this.persist(job, entry, !loaded)
    return this.remember(job.key, entry)
  }

  /** Remember a decision just made, unless a flag got there first: a flagged outcome is never replaced. */
  private remember(key: string, entry: Remembered): Remembered {
    const current = this.decided.get(key)
    if (current && isFlagged(current)) return current
    this.decided.set(key, entry)
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
    // Every answered call costs the worker tokens, an answer that was rejected included.
    if ('tokensIn' in outcome) {
      this.workerIn += outcome.tokensIn
      this.workerOut += outcome.tokensOut
    }
    if ('text' in outcome) return { condensed: outcome.text }
    if (outcome.reason === 'rejected') return { whole: 'rejected' }
    if (outcome.problem === 'partial-input') {
      this.workerIn += outcome.read ?? 0
      this.warnOnce('partial-input', `the worker read ${outcome.read ?? 0} of the ${outcome.sent ?? 0} tokens it was sent, so it answered from part of the output and the tool result is forwarded whole. Raise the worker's context window above ${outcome.sent ?? 0} tokens (for Ollama, num_ctx)`, { read: outcome.read, sent: outcome.sent })
    } else {
      this.warnOnce(outcome.problem, WORKER_PROBLEMS[outcome.problem])
    }
    return { whole: 'worker-failed' }
  }

  /**
   * Run `write` after every write already queued for `key`. All the disk
   * writes of one result go through here, so a flag that arrives while a
   * condensation is being written is applied after it, never before: the
   * original cannot be written back over the flip that deleted it.
   */
  private onDisk(key: string, write: () => Promise<void>): Promise<void> {
    const run = (this.diskChain.get(key) ?? Promise.resolve()).then(write)
    const tail = run.then(() => undefined, () => undefined)
    this.diskChain.set(key, tail)
    void tail.then(() => {
      if (this.diskChain.get(key) === tail) this.diskChain.delete(key)
    })
    return run
  }

  /**
   * Write the original of a condensed result, then its outcome file when
   * `writeOutcome` (or when the original could not be stored and the outcome
   * is now "whole"). A condensed result whose original is not on disk becomes
   * whole: the agent would be told to read a file that is not there. A flagged
   * result keeps only its outcome, and its original, if there is one, is deleted.
   */
  private persist(job: Job, entry: Remembered, writeOutcome: boolean): Promise<void> {
    return this.onDisk(job.key, async () => {
      // Its turn has come, and the result may have been flagged while it waited.
      if (isFlagged(this.decided.get(job.key)) && !isFlagged(entry)) return
      if (isFlagged(entry)) {
        if (writeOutcome) await this.keepFlagged(job)
        entry.stored = true
        return
      }
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
    })
  }

  /** The outcome file of a flagged result says only that, and no file holds its text. */
  private async keepFlagged(job: Job): Promise<void> {
    const stored = await this.store.writeOutcome(job.key, { whole: 'flagged' })
    if (stored !== 'stored') this.warnOnce(`store-${stored}`, STORE_PROBLEMS[stored], { file: 'outcome' })
    await this.store.remove(job.text)
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
    for (const [key, entry] of this.decided) if (now - entry.carriedAt > retention && !isFlagged(entry)) this.decided.delete(key)
  }

  protected override apply(payload: Record<string, unknown>, ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome {
    this.current = ctx
    this.estimates = estimates
    try {
      return super.apply(payload, ctx, estimates)
    } finally {
      this.current = undefined
      this.estimates = undefined
    }
  }

  protected rewrite(text: string, slot: TextSlot): string {
    const found = this.classify(slot, this.current?.remoteAddress)
    if (found && 'whole' in found) {
      this.wholeCount[found.whole]++
      return text
    }
    const decision = found && this.decided.get(found.job.key)?.decision
    if (!decision) return text
    if ('whole' in decision) {
      this.wholeCount[decision.whole]++
      return text
    }
    const estimates = this.estimates ?? new Map<string, number>()
    this.condensedCount++
    this.originalTokens += estimate(text, estimates)
    this.condensedTokens += estimate(decision.condensed, estimates)
    return decision.condensed
  }

  private sampleWait(ms: number): void {
    this.waitSamples++
    this.waitTotalMs += ms
    this.waitMaxMs = Math.max(this.waitMaxMs, ms)
  }

  override getStats(): ModuleStats {
    const { files, bytes } = this.store.stats()
    const whole = Object.entries(this.wholeCount).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${count}`).join(' · ')
    return {
      ...super.getStats(),
      kpis: [
        { key: 'condensed', label: 'Results condensed', value: this.condensedCount },
        { key: 'whole', label: 'Forwarded whole', value: whole || 'none' },
        { key: 'originalTokens', label: 'Original tokens', value: this.originalTokens },
        { key: 'condensedTokens', label: 'Condensed tokens', value: this.condensedTokens },
        { key: 'workerIn', label: 'Worker tokens read', value: this.workerIn },
        { key: 'workerOut', label: 'Worker tokens written', value: this.workerOut },
        { key: 'waitAvgMs', label: 'Average wait added (ms)', value: this.waitSamples > 0 ? Math.round(this.waitTotalMs / this.waitSamples) : 0 },
        { key: 'waitMaxMs', label: 'Longest wait added (ms)', value: this.waitMaxMs },
        { key: 'storedFiles', label: 'Stored originals', value: files },
        { key: 'storedBytes', label: 'Stored size (bytes)', value: bytes },
        // Counted from T028, when a stored original is found gone.
        { key: 'missing', label: 'Stored originals missing', value: 0 },
      ],
    }
  }

  /** Clears the counters and events; the folder is untouched, so its totals stay. */
  override resetStats(): void {
    super.resetStats()
    this.condensedCount = 0
    this.wholeCount = noReasons()
    this.originalTokens = 0
    this.condensedTokens = 0
    this.workerIn = 0
    this.workerOut = 0
    this.waitSamples = 0
    this.waitTotalMs = 0
    this.waitMaxMs = 0
  }
}
