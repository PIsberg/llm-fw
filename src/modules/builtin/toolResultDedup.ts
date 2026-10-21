import crypto from 'node:crypto'
import type { ToolResultDedupConfig } from '../../types.js'
import type { GatewayModuleContext } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { SlotModule, type PayloadOutcome } from '../base.js'
import type { SlotKind, TextSlot } from '../payload.js'
import { responseEvents } from '../usage.js'

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'
const REMINDER_MARKER = '[llm-fw: identical system-reminder omitted]'
const MAX_THREADS = 256
const MAX_HASHES_PER_THREAD = 512

type Obj = Record<string, unknown>
interface ThreadState { seen: Map<string, string>; reminders: Set<string>; ordinal: number }
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const digest = (text: string): string => crypto.createHash('sha256').update(text).digest('hex')

// Response id an Anthropic message (`id` or `message.id` on message_start) or
// OpenAI Responses API payload (`id` or `response.id` on response.created /
// response.completed) carries, so the next continuation can chain its seen map.
function extractResponseId(events: unknown[]): string | undefined {
  for (const e of events) {
    if (!isObj(e)) continue
    if (typeof e.id === 'string' && e.id !== '') return e.id
    if (isObj(e.message) && typeof e.message.id === 'string' && e.message.id !== '') return e.message.id
    if (isObj(e.response) && typeof e.response.id === 'string' && e.response.id !== '') return e.response.id
  }
  return undefined
}

function parentChainId(payload: Obj): string | undefined {
  if (isObj(payload.thread) && payload.thread.type === 'continue' && typeof payload.thread.previous_message_id === 'string' && payload.thread.previous_message_id !== '') {
    return payload.thread.previous_message_id
  }
  if (typeof payload.previous_response_id === 'string' && payload.previous_response_id !== '') {
    return payload.previous_response_id
  }
  return undefined
}

/**
 * Strips repeated `<system-reminder>...</system-reminder>` blocks once an
 * identical body has already appeared in `reminders`. Only a trusted slot
 * (`record`, the client's own user-turn text) adds to `reminders`: tool
 * output and the model's own turns are untrusted, and a copy planted or
 * echoed there must not make a later genuine reminder disappear.
 *
 * indexOf rather than a regex: tool output can hold thousands of unclosed
 * openers, and a lazy `[\s\S]*?` rescans to the end of the text from each.
 */
export function dedupReminders(text: string, reminders: Set<string>, record: boolean): string {
  let open = text.indexOf(REMINDER_OPEN)
  if (open < 0) return text
  let out = ''
  let last = 0
  while (open >= 0) {
    const close = text.indexOf(REMINDER_CLOSE, open + REMINDER_OPEN.length)
    if (close < 0) break
    const end = close + REMINDER_CLOSE.length
    const key = digest(text.slice(open + REMINDER_OPEN.length, close).trim())
    if (reminders.has(key)) {
      out += text.slice(last, open) + REMINDER_MARKER
      last = end
    } else if (record) {
      reminders.add(key)
      if (reminders.size > MAX_HASHES_PER_THREAD) reminders.delete(reminders.values().next().value!)
    }
    open = text.indexOf(REMINDER_OPEN, end)
  }
  return last === 0 ? text : out + text.slice(last)
}

// Thread state belongs to the tenant and provider that created it, so a
// request naming another tenant's response id starts empty instead of
// learning which tool output that tenant had already sent.
const threadKey = (ctx: GatewayModuleContext, id: string): string => `${ctx.tenant ?? ''}\0${ctx.target}\0${id}`

/**
 * An agent rereads the same file, reruns the same command, and every copy
 * stays in the history it resends. A tool result identical to an earlier
 * one in the same request — or an earlier turn of the same server-side
 * thread — becomes a pointer to it, and repeated `<system-reminder>` blocks
 * inside prompt or tool text collapse after their first appearance.
 *
 * Which copy is kept depends only on what comes before it, so a history
 * that only grows is rewritten the same way on every turn and the prompt
 * cache keeps matching.
 */
export class ToolResultDedupModule extends SlotModule<ToolResultDedupConfig> {
  readonly id = 'tool-result-dedup'
  readonly name = 'Tool Result Deduplicator'
  readonly description = 'Replaces a tool result identical to an earlier one in the same conversation or thread with a pointer to it, and collapses repeated <system-reminder> blocks'
  protected readonly kinds: ReadonlySet<SlotKind> = new Set(['tool_result', 'prompt'])

  private seen = new Map<string, string>()
  private reminders = new Set<string>()
  private ordinal = 0
  // Server-side thread chain: response id -> { seen, reminders, ordinal }.
  private readonly threads = new Map<string, ThreadState>()
  // State after a request, until its response names the id to chain it to.
  // Keyed on the request's context, not its body: the body observeResponse
  // gets has been through every module and DLP stage after this one, so it
  // rarely matches what this module produced. A request whose response is
  // never observed leaves nothing behind.
  private readonly pending = new WeakMap<GatewayModuleContext, ThreadState>()

  constructor(config?: ToolResultDedupConfig) {
    super(config ?? { enabled: false, minLength: 200 })
  }

  protected override apply(payload: Obj, ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome {
    const parentId = parentChainId(payload)
    const parent = parentId ? this.threads.get(threadKey(ctx, parentId)) : undefined
    this.seen = new Map(parent?.seen)
    this.reminders = new Set(parent?.reminders)
    this.ordinal = parent ? parent.ordinal : 0

    const outcome = super.apply(payload, ctx, estimates)

    const isThread = parentId !== undefined || (isObj(payload.thread) && payload.thread.type === 'create')
    if (isThread || payload.store === true || Array.isArray(payload.input)) {
      this.pending.set(ctx, { seen: new Map(this.seen), reminders: new Set(this.reminders), ordinal: this.ordinal })
    }
    return outcome
  }

  observeResponse(_requestBody: string, ctx: GatewayModuleContext, response: CapturedResponse): void {
    const snap = this.pending.get(ctx)
    if (!snap) return
    this.pending.delete(ctx)
    const events = responseEvents(response.body, response.headers)
    if (!events) return
    const respId = extractResponseId(events)
    if (!respId) return
    const key = threadKey(ctx, respId)
    this.threads.delete(key)
    this.threads.set(key, snap)
    if (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value!)
  }

  protected rewrite(text: string, slot: TextSlot): string {
    const cleaned = dedupReminders(text, this.reminders, slot.kind === 'prompt' && slot.role === 'user')
    if (slot.kind !== 'tool_result') return cleaned
    this.ordinal++
    if (cleaned.length < this.cfg.minLength) return cleaned
    const key = digest(cleaned)
    const first = this.seen.get(key)
    if (first !== undefined) return `[llm-fw: identical to the earlier tool result ${first}]`
    this.seen.set(key, slot.toolCallId ?? `#${this.ordinal}`)
    if (this.seen.size > MAX_HASHES_PER_THREAD) this.seen.delete(this.seen.keys().next().value!)
    return cleaned
  }
}
