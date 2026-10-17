import type { HistoryWindowConfig } from '../../types.js'
import type { GatewayModuleContext } from '../types.js'
import { PayloadModule, estimate, type PayloadOutcome } from '../base.js'
import { collectTextSlots } from '../payload.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const marker = (dropped: number): string => `[llm-fw: ${dropped} earlier messages omitted]`

// Where to cut a conversation of `n` turns: past the window by a whole
// number of steps, then forward to the first plain user turn, so a tool
// call is never separated from its result and the kept history starts the
// way every provider requires. Null when nothing needs cutting or no plain
// user turn follows.
function cutIndex(n: number, maxMessages: number, step: number, isPlainUser: (i: number) => boolean): number | null {
  const max = Math.max(2, Math.floor(maxMessages))
  if (n <= max) return null
  const s = Math.max(1, Math.floor(step))
  let cut = Math.ceil((n - max) / s) * s
  while (cut < n && !isPlainUser(cut)) cut++
  return cut < n ? cut : null
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
    if (!Array.isArray(payload.messages) && !Array.isArray(payload.contents)) return null
    const before = textTokens(payload, estimates)
    const changed = Array.isArray(payload.messages)
      ? this.windowMessages(payload, payload.messages)
      : this.windowContents(payload, payload.contents as unknown[])
    return { changed, tokensOriginal: before, tokensPruned: changed ? textTokens(payload, estimates) : before }
  }

  // OpenAI chat and Anthropic: leading system and developer messages stay.
  private windowMessages(payload: Obj, messages: unknown[]): boolean {
    let lead = 0
    while (lead < messages.length && isObj(messages[lead]) && ((messages[lead] as Obj).role === 'system' || (messages[lead] as Obj).role === 'developer')) lead++
    const turns = messages.slice(lead)
    const isPlainUser = (i: number): boolean => {
      const m = turns[i]
      if (!isObj(m) || m.role !== 'user') return false
      if (typeof m.content === 'string') return true
      return Array.isArray(m.content) && !m.content.some(b => isObj(b) && b.type === 'tool_result')
    }
    const cut = cutIndex(turns.length, this.cfg.maxMessages, this.cfg.step, isPlainUser)
    if (cut === null) return false

    const kept = turns.slice(cut).map(m => structuredClone(m) as Obj)
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

  // Gemini: the system instruction is a separate field; a user turn that
  // answers a function call carries a functionResponse part.
  private windowContents(payload: Obj, contents: unknown[]): boolean {
    const isPlainUser = (i: number): boolean => {
      const c = contents[i]
      return isObj(c) && c.role === 'user' && Array.isArray(c.parts) && !c.parts.some(p => isObj(p) && 'functionResponse' in p)
    }
    const cut = cutIndex(contents.length, this.cfg.maxMessages, this.cfg.step, isPlainUser)
    if (cut === null) return false
    const kept = contents.slice(cut).map(c => structuredClone(c) as Obj)
    ;(kept[0]!.parts as unknown[]).unshift({ text: marker(cut) })
    payload.contents = kept
    return true
  }
}
