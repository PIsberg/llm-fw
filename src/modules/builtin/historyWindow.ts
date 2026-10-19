import type { HistoryWindowConfig } from '../../types.js'
import type { GatewayModuleContext } from '../types.js'
import { PayloadModule, estimate, type PayloadOutcome } from '../base.js'
import { collectTextSlots } from '../payload.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const marker = (dropped: number): string => `[llm-fw: ${dropped} earlier messages omitted]`

const ORPHAN = '[llm-fw: result of an omitted tool call]'

// Where to cut a conversation of `n` turns: past the window by a whole
// number of steps, then forward to the first turn on the user's side (a user
// or tool message), so the kept history starts the way every provider
// requires. Results whose call was dropped are turned into text afterwards
// (see orphanText), so the cut never has to wait for a plain user turn: an
// agent loop has none for hundreds of turns. Null when nothing needs cutting
// or no user-side turn follows.
function cutIndex(n: number, maxMessages: number, step: number, isUserSide: (i: number) => boolean): number | null {
  const max = Math.max(2, Math.floor(maxMessages))
  if (n <= max) return null
  const s = Math.max(1, Math.floor(step))
  let cut = Math.ceil((n - max) / s) * s
  while (cut < n && !isUserSide(cut)) cut++
  return cut < n ? cut : null
}

// An Anthropic tool_result as user content: its text behind the ORPHAN
// line, any image or document parts after it.
function orphanBlocks(result: Obj): unknown[] {
  const parts: unknown[] = typeof result.content === 'string'
    ? [{ type: 'text', text: result.content }]
    : Array.isArray(result.content) ? result.content : []
  const out: unknown[] = []
  let labelled = false
  for (const part of parts) {
    if (!labelled && isObj(part) && part.type === 'text' && typeof part.text === 'string') {
      out.push({ type: 'text', text: `${ORPHAN}\n${part.text}` })
      labelled = true
    } else {
      out.push(part)
    }
  }
  if (!labelled) out.unshift({ type: 'text', text: ORPHAN })
  return out
}

// Kept turns whose tool call was cut off: a provider refuses a result whose
// call is not in the request, so each becomes user text.
function orphanText(kept: Obj[]): void {
  const calls = new Set<string>()
  for (const m of kept) {
    if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (isObj(c) && typeof c.id === 'string') calls.add(c.id)
    if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (isObj(b) && b.type === 'tool_use' && typeof b.id === 'string') calls.add(b.id)
  }
  for (const m of kept) {
    if (m.role === 'tool' && !(typeof m.tool_call_id === 'string' && calls.has(m.tool_call_id))) {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      for (const key of Object.keys(m)) delete m[key]
      Object.assign(m, { role: 'user', content: `${ORPHAN}\n${text}` })
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      m.content = (m.content as unknown[]).flatMap((b): unknown[] => isObj(b) && b.type === 'tool_result' && !(typeof b.tool_use_id === 'string' && calls.has(b.tool_use_id)) ? orphanBlocks(b) : [b])
    }
  }
}

const textTokens = (payload: unknown, estimates: Map<string, number>): number =>
  collectTextSlots(payload).reduce((sum, slot) => sum + estimate(slot.text, estimates), 0)

/**
 * Keeps the last `maxMessages` turns of a long conversation, plus its system
 * prompt. Lossy: the model no longer sees what was dropped.
 *
 * The cut moves in whole `step`s, so between two moves the kept history is a
 * stable prefix and the prompt cache keeps matching; each move costs one
 * cache miss. Dropping turns from the front changes the recorded prefix of
 * every thinking block after them, so those blocks are removed from the
 * turns that are kept; sending them would be refused on models that check
 * it.
 */
export class HistoryWindowModule extends PayloadModule<HistoryWindowConfig> {
  readonly id = 'history-window'
  readonly name = 'History Window'
  readonly description = 'Keeps the last turns of a long conversation, dropping the oldest in whole steps so the cached prefix holds between steps'

  constructor(config?: HistoryWindowConfig) {
    super(config ?? { enabled: false, maxMessages: 60, step: 20 })
  }

  protected apply(payload: Obj, _ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome | null {
    if (!Array.isArray(payload.messages) && !Array.isArray(payload.contents) && !Array.isArray(payload.input)) return null
    // A server-side thread continuation (Claude Code against api.anthropic.com)
    // carries only the turn's new messages; the server holds the history.
    // Cutting it would drop content the server has never seen. The same for
    // a Responses API request that continues a stored response.
    if (isObj(payload.thread) && payload.thread.type === 'continue') return null
    if (typeof payload.previous_response_id === 'string') return null
    const before = textTokens(payload, estimates)
    const changed = Array.isArray(payload.messages)
      ? this.windowMessages(payload, payload.messages)
      : Array.isArray(payload.contents)
        ? this.windowContents(payload, payload.contents)
        : this.windowInput(payload, payload.input as unknown[])
    return { changed, tokensOriginal: before, tokensPruned: changed ? textTokens(payload, estimates) : before }
  }

  // OpenAI chat and Anthropic: leading system and developer messages stay.
  private windowMessages(payload: Obj, messages: unknown[]): boolean {
    let lead = 0
    while (lead < messages.length && isObj(messages[lead]) && ((messages[lead] as Obj).role === 'system' || (messages[lead] as Obj).role === 'developer')) lead++
    const turns = messages.slice(lead)
    const isUserSide = (i: number): boolean => {
      const m = turns[i]
      return isObj(m) && (m.role === 'user' || m.role === 'tool')
    }
    const cut = cutIndex(turns.length, this.cfg.maxMessages, this.cfg.step, isUserSide)
    if (cut === null) return false

    const kept = turns.slice(cut).map(m => structuredClone(m) as Obj)
    orphanText(kept)
    const first = kept[0]!
    if (typeof first.content === 'string') first.content = `${marker(cut)}\n\n${first.content}`
    else (first.content as unknown[]).unshift({ type: 'text', text: marker(cut) })
    for (const m of kept) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
      const visible = m.content.filter(b => !(isObj(b) && (b.type === 'thinking' || b.type === 'redacted_thinking')))
      if (visible.length !== m.content.length) {
        m.content = visible.length > 0 ? visible : [{ type: 'text', text: '[llm-fw: reasoning omitted]' }]
      }
    }
    payload.messages = [...messages.slice(0, lead), ...kept]
    return true
  }

  // Responses API, history client side (#355): message items, function_call
  // and function_call_output pairs, and reasoning items. Leading system and
  // developer messages stay. The cut lands on a user message or on an output,
  // never between a call and its output: an output whose call is gone
  // becomes user text, since the API refuses it on its own. Reasoning items
  // in the kept history go, as thinking blocks do above: their encrypted
  // content records the conversation before them.
  private windowInput(payload: Obj, input: unknown[]): boolean {
    let lead = 0
    while (lead < input.length && isObj(input[lead]) && ((input[lead] as Obj).role === 'system' || (input[lead] as Obj).role === 'developer')) lead++
    const items = input.slice(lead)
    const isUserSide = (i: number): boolean => {
      const m = items[i]
      return isObj(m) && (m.type === 'function_call_output' || ((m.type === undefined || m.type === 'message') && m.role === 'user'))
    }
    const cut = cutIndex(items.length, this.cfg.maxMessages, this.cfg.step, isUserSide)
    if (cut === null) return false

    const kept = items.slice(cut).map(m => structuredClone(m) as Obj).filter(m => m.type !== 'reasoning')
    const calls = new Set<string>()
    for (const m of kept) if (m.type === 'function_call' && typeof m.call_id === 'string') calls.add(m.call_id)
    for (const m of kept) {
      if (m.type !== 'function_call_output' || (typeof m.call_id === 'string' && calls.has(m.call_id))) continue
      const text = typeof m.output === 'string' ? m.output : JSON.stringify(m.output ?? '')
      for (const key of Object.keys(m)) delete m[key]
      Object.assign(m, { role: 'user', content: [{ type: 'input_text', text: `${ORPHAN}\n${text}` }] })
    }
    const first = kept[0]
    if (!first) return false
    if (typeof first.content === 'string') first.content = `${marker(cut)}\n\n${first.content}`
    else if (Array.isArray(first.content)) first.content.unshift({ type: 'input_text', text: marker(cut) })
    else kept.unshift({ role: 'user', content: marker(cut) })
    payload.input = [...input.slice(0, lead), ...kept]
    return true
  }

  // Gemini: the system instruction is a separate field; a user turn that
  // answers a function call carries a functionResponse part, which becomes
  // text when the call before it is cut off.
  private windowContents(payload: Obj, contents: unknown[]): boolean {
    const isUserSide = (i: number): boolean => {
      const c = contents[i]
      return isObj(c) && c.role === 'user' && Array.isArray(c.parts)
    }
    const cut = cutIndex(contents.length, this.cfg.maxMessages, this.cfg.step, isUserSide)
    if (cut === null) return false
    const kept = contents.slice(cut).map(c => structuredClone(c) as Obj)
    const first = kept[0]!
    first.parts = (first.parts as unknown[]).map(p => isObj(p) && 'functionResponse' in p ? { text: `${ORPHAN}\n${JSON.stringify(p.functionResponse)}` } : p)
    ;(first.parts as unknown[]).unshift({ text: marker(cut) })
    payload.contents = kept
    return true
  }
}
