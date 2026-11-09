import fs from 'node:fs'
import { dirname } from 'node:path'
import type { ModuleSwitchConfig, ToolFilterConfig } from '../../types.js'
import type { GatewayModuleContext, ModuleAction, ModuleStats } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { PayloadModule, estimate, type PayloadOutcome } from '../base.js'
import { responseCalls } from '../toolCalls.js'
import { matchesAny, parseSkillListing, skillListingSlots, toolName } from './toolFilter.js'
import { createLogger } from '../../logger.js'

const log = createLogger('tool-usage')

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What persistTo keeps between processes: tool names and counts, no request content. */
interface SavedUsage {
  requests: number
  calls: number
  offered: Record<string, number>
  called: string[]
  /** Calls per tool. Absent from a file written before the counts existed. */
  counts?: Record<string, number>
  /** Requests whose tool list held the tool. Absent from such a file too. */
  offeredOn?: Record<string, number>
  /** Skills of the client's skill listing, with the token estimate of each entry. */
  skills?: Record<string, number>
  /** Invocations per skill, through the Skill tool. */
  skillCalls?: Record<string, number>
}
// Coalesce writes: one per this many ms while traffic flows.
const SAVE_DELAY_MS = 5000

// Bounds on what one process remembers: every distinct tool name a client
// offered, and the ids of calls already counted, oldest evicted first.
const MAX_TOOLS = 2000
const MAX_CALL_IDS = 8192
// How many never-called tools the card lists.
const DETAIL_LIMIT = 30
// Calls seen before the card offers the list to the Tool Filter (#407): a
// tool not called yet may still be needed, and the click removes it from
// what the model can call.
const MIN_EVIDENCE_CALLS = 1000
// When a stub pays. A shortened tool's whole definition comes back the first
// time a conversation calls it, and that changes the front of the prompt: the
// provider writes the whole prompt to its cache again, at 2 times the input
// price where reading it would have cost 0.1. On a 250,000-token prompt (the
// mean of one developer's Claude Code calls was 260,000) that is 475,000
// tokens of input, against a tenth of the definition saved on every call the
// stub was sent. Counting every call of the tool as such a rewrite, and
// asking for the saving to be 4 times the cost:
//
//   calls of the tool x REWRITE_TOKENS <= definition tokens x calls it was offered on
//
// Measured on 30 days of that developer's transcripts (52,612 API calls): the
// two tools this picks saved a net 1.1% of the bill, while every tool called
// under once in 200 calls, picked without it, lost 4.0% (238 rewrites).
const REWRITE_TOKENS = 19_000_000
// The tool Claude Code invokes a skill through, with the skill's name in its
// `skill` argument.
const SKILL_TOOL = 'Skill'

// The skill a Skill call names: its input is an object in a request's
// history and in a whole response, a JSON string in a streamed one.
function skillOf(input: unknown): string | undefined {
  let args = input
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return undefined }
  }
  if (!isObj(args) || typeof args.skill !== 'string') return undefined
  const name = args.skill.startsWith('/') ? args.skill.slice(1) : args.skill
  return name === '' ? undefined : name
}

// Each tool definition in the Anthropic, OpenAI chat, Responses API and
// Gemini shapes, with the JSON it is billed as.
function offeredTools(payload: Obj): Array<{ name: string; json: string }> {
  if (!Array.isArray(payload.tools)) return []
  const out: Array<{ name: string; json: string }> = []
  for (const tool of payload.tools) {
    const decls = isObj(tool) && Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations as unknown[] : [tool]
    for (const d of decls) {
      const name = toolName(d)
      if (name) out.push({ name, json: JSON.stringify(d) })
    }
  }
  return out
}

const idOr = (id: unknown, fallback: string): string => typeof id === 'string' && id !== '' ? id : fallback

// Calls a request's history carries, as [id, name, input]; Gemini calls carry
// no id, so their name stands in for one. The input is given for Anthropic
// tool_use blocks only, which is where a skill invocation is.
function historyCalls(payload: Obj): Array<[string, string, unknown?]> {
  const out: Array<[string, string, unknown?]> = []
  const turns = [payload.messages, payload.input, payload.contents].filter(Array.isArray).flat() as unknown[]
  for (const turn of turns) {
    if (!isObj(turn)) continue
    if (turn.type === 'function_call' && typeof turn.name === 'string') out.push([idOr(turn.call_id, turn.name), turn.name])
    if (Array.isArray(turn.tool_calls)) {
      for (const c of turn.tool_calls) {
        const name = toolName(c)
        if (name && isObj(c)) out.push([idOr(c.id, name), name])
      }
    }
    const parts = Array.isArray(turn.content) ? turn.content : Array.isArray(turn.parts) ? turn.parts : []
    for (const p of parts) {
      if (!isObj(p)) continue
      if (p.type === 'tool_use' && typeof p.name === 'string') out.push([idOr(p.id, p.name), p.name, p.input])
      if (isObj(p.functionCall) && typeof p.functionCall.name === 'string') out.push([`gemini:${p.functionCall.name}`, p.functionCall.name])
    }
  }
  return out
}

// What the one-click says it will do, from how many tools it drops, tools it
// shortens and skills it drops.
function actionLabel(drop: number, shorten: number, skills: number): string {
  if (skills === 0) {
    if (shorten === 0) return `Drop these ${drop} tools in the Tool Filter`
    if (drop === 0) return `Shorten these ${shorten} rarely called tools in the Tool Filter`
    return `Drop ${drop} never-called and shorten ${shorten} rarely called tools in the Tool Filter`
  }
  if (drop === 0 && shorten === 0) return `Drop these ${skills} never-invoked skills in the Tool Filter`
  const parts = [
    ...(drop > 0 ? [`drop ${drop} never-called tools`] : []),
    ...(shorten > 0 ? [`shorten ${shorten} rarely called tools`] : []),
    `drop ${skills} never-invoked skills`,
  ]
  const text = `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`
  return `${text[0]!.toUpperCase()}${text.slice(1)} in the Tool Filter`
}

/**
 * Records which offered tools a client actually calls, and how often, so you
 * know which to name in the Tool Filter's dropTools (never called) and
 * shortenTools (called now and then). Does the same for the skills of Claude
 * Code's skill listing, which the Skill tool invokes, for dropSkills. Every tool definition is billed on every
 * request, as a cache read once cached; one the model never calls is cost with
 * no use. Calls are learned from the request history and from responses,
 * because a request that continues a server-side thread (Claude Code through
 * the proxy) carries tool results without the calls. Reads only, and runs after
 * the Tool Filter and the definition pruner, so the list is what still costs.
 */
export class ToolUsageModule extends PayloadModule<ModuleSwitchConfig> {
  readonly id = 'tool-usage'
  readonly name = 'Tool Usage'
  readonly description = 'Records which offered tools get called, and lists the ones that never or rarely do with their token cost, for the Tool Filter. Changes nothing.'

  private requests = 0
  // Name to the token estimate of its definition as last offered.
  private readonly offered = new Map<string, number>()
  // Calls per tool. Infinity for a tool a file without counts lists as
  // called: how often is unknown, so it is never taken for rare.
  private readonly called = new Map<string, number>()
  // Requests whose tool list held the tool: a deferred tool is offered on
  // few of them, and a stub saves only where the definition was sent.
  private readonly offeredOn = new Map<string, number>()
  // The client's skill listing: name to the token estimate of its entry, and
  // how often each skill was invoked through the Skill tool.
  private readonly skills = new Map<string, number>()
  private readonly skillCalls = new Map<string, number>()
  private readonly countedCalls = new Set<string>()
  private calls = 0

  // Where the totals survive a restart; unset in tests and library use, so
  // nothing reads or writes a file unless `llm-fw start` asks for it.
  private file: string | undefined
  private saveTimer: NodeJS.Timeout | undefined
  // The Tool Filter's live config, read when the card is drawn, so the
  // action names only tools the filter does not cover yet.
  private readonly filter: (() => ToolFilterConfig | undefined) | undefined

  constructor(config?: ModuleSwitchConfig, filter?: () => ToolFilterConfig | undefined) {
    super(config ?? { enabled: true })
    this.filter = filter
  }

  /**
   * Keep the totals in `file` across restarts: load what is there, then
   * write changes back at most every SAVE_DELAY_MS. A list that started empty
   * on every restart never held enough evidence to name a tool in the Tool
   * Filter. A missing or unreadable file starts empty.
   */
  persistTo(file: string): void {
    this.file = file
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SavedUsage>
      if (typeof saved.requests === 'number') this.requests = saved.requests
      if (typeof saved.calls === 'number') this.calls = saved.calls
      for (const [name, n] of Object.entries(saved.offered ?? {}).slice(0, MAX_TOOLS)) {
        if (typeof n === 'number') this.offered.set(name, n)
      }
      const counts = saved.counts ?? {}
      for (const name of (saved.called ?? []).slice(0, MAX_TOOLS)) {
        if (typeof name !== 'string') continue
        const n = Object.hasOwn(counts, name) ? counts[name] : undefined
        this.called.set(name, typeof n === 'number' && n > 0 ? n : Infinity)
      }
      for (const [name, n] of Object.entries(saved.offeredOn ?? {}).slice(0, MAX_TOOLS)) {
        if (typeof n === 'number' && this.offered.has(name)) this.offeredOn.set(name, n)
      }
      for (const [name, n] of Object.entries(saved.skills ?? {}).slice(0, MAX_TOOLS)) if (typeof n === 'number') this.skills.set(name, n)
      for (const [name, n] of Object.entries(saved.skillCalls ?? {}).slice(0, MAX_TOOLS)) if (typeof n === 'number') this.skillCalls.set(name, n)
    } catch { /* nothing saved yet, or unreadable: start empty */ }
  }

  /** Write the totals now, if persisting. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (!this.file) return
    const counts = Object.fromEntries([...this.called].filter(([, n]) => Number.isFinite(n)))
    const saved: SavedUsage = { requests: this.requests, calls: this.calls, offered: Object.fromEntries(this.offered), called: [...this.called.keys()], counts, offeredOn: Object.fromEntries(this.offeredOn), skills: Object.fromEntries(this.skills), skillCalls: Object.fromEntries(this.skillCalls) }
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(saved), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      log.warn('could not save tool usage; it stays in memory', { err })
    }
  }

  private changed(): void {
    if (!this.file || this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
    this.saveTimer.unref()
  }

  private count(id: string, name: string, input?: unknown): void {
    if (this.countedCalls.has(id)) return
    this.countedCalls.add(id)
    if (this.countedCalls.size > MAX_CALL_IDS) this.countedCalls.delete(this.countedCalls.values().next().value!)
    this.calls++
    this.called.set(name, (this.called.get(name) ?? 0) + 1)
    const skill = name === SKILL_TOOL ? skillOf(input) : undefined
    if (skill !== undefined && (this.skillCalls.has(skill) || this.skillCalls.size < MAX_TOOLS)) {
      this.skillCalls.set(skill, (this.skillCalls.get(skill) ?? 0) + 1)
    }
    this.changed()
  }

  protected apply(payload: Obj, _ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome | null {
    const tools = offeredTools(payload)
    if (tools.length > 0) {
      this.requests++
      const names = new Set<string>()
      for (const { name, json } of tools) {
        if (!this.offered.has(name) && this.offered.size >= MAX_TOOLS) continue
        this.offered.set(name, estimate(json, estimates))
        names.add(name)
      }
      for (const name of names) this.offeredOn.set(name, (this.offeredOn.get(name) ?? 0) + 1)
      this.changed()
    }
    for (const slot of skillListingSlots(payload)) {
      const entries = parseSkillListing(slot.text)
      if (!entries) continue
      for (const entry of entries) {
        if (!this.skills.has(entry.name) && this.skills.size >= MAX_TOOLS) continue
        this.skills.set(entry.name, estimate(slot.text.slice(entry.start, entry.end), estimates))
      }
      this.changed()
    }
    for (const [id, name, input] of historyCalls(payload)) this.count(id, name, input)
    return null
  }

  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    if (!this.enabled) return
    for (const call of responseCalls(response)) this.count(call.id, call.name, call.input)
  }

  private neverCalled(): Array<[string, number]> {
    return [...this.offered].filter(([name]) => !this.called.has(name)).sort((a, b) => b[1] - a[1])
  }

  private neverInvoked(): Array<[string, number]> {
    return [...this.skills].filter(([name]) => !this.skillCalls.has(name)).sort((a, b) => b[1] - a[1])
  }

  // Offered tools called so rarely that a stub pays (see REWRITE_TOKENS), as
  // [name, definition tokens, calls], largest first. Empty until enough
  // calls have been seen.
  private rarelyCalled(): Array<[string, number, number]> {
    if (this.calls < MIN_EVIDENCE_CALLS || this.requests === 0) return []
    const out: Array<[string, number, number]> = []
    for (const [name, tokens] of this.offered) {
      const n = this.called.get(name)
      if (n === undefined) continue
      // Requests with a tool list stand for all calls: a client that
      // continues a server-side thread sends the list on a few of them.
      const offeredCalls = this.calls * (this.offeredOn.get(name) ?? 0) / this.requests
      if (n * REWRITE_TOKENS <= tokens * offeredCalls) out.push([name, tokens, n])
    }
    return out.sort((a, b) => b[1] - a[1])
  }

  // The one-click change for the Tool Filter: its current lists plus every
  // never-called tool (to drop), rarely called one (to shorten) and
  // never-invoked skill (to drop from the listing) it does not match yet,
  // offered once enough calls have been seen. Undefined without a filter to
  // write to, or nothing to add.
  private action(never: Array<[string, number]>, rare: Array<[string, number, number]>, idle: Array<[string, number]>): { action?: ModuleAction; hint: string } {
    const filter = this.filter?.()
    if (!filter) return { hint: '' }
    const dropped = Array.isArray(filter.dropTools) ? filter.dropTools : []
    const shortened = Array.isArray(filter.shortenTools) ? filter.shortenTools : []
    const droppedSkills = Array.isArray(filter.dropSkills) ? filter.dropSkills : []
    const drop = never.map(([name]) => name).filter(name => !matchesAny(dropped, name))
    const shorten = rare.map(([name]) => name).filter(name => !matchesAny(dropped, name) && !matchesAny(shortened, name))
    const skills = idle.map(([name]) => name).filter(name => !matchesAny(droppedSkills, name))
    if (drop.length === 0 && shorten.length === 0 && skills.length === 0) return { hint: '' }
    if (this.calls < MIN_EVIDENCE_CALLS) return { hint: ` The Tool Filter action appears after ${MIN_EVIDENCE_CALLS.toLocaleString('en-US')} calls (${this.calls.toLocaleString('en-US')} so far).` }
    return {
      action: {
        label: actionLabel(drop.length, shorten.length, skills.length),
        module: 'tool-filter',
        enabled: true,
        options: {
          ...(drop.length > 0 ? { dropTools: [...dropped, ...drop] } : {}),
          ...(shorten.length > 0 ? { shortenTools: [...shortened, ...shorten] } : {}),
          ...(skills.length > 0 ? { dropSkills: [...droppedSkills, ...skills] } : {}),
        },
      },
      hint: '',
    }
  }

  getStats(): ModuleStats {
    const never = this.neverCalled()
    const neverTokens = never.reduce((sum, [, n]) => sum + n, 0)
    const listed = never.slice(0, DETAIL_LIMIT).map(([name, n]) => `${name} (${n.toLocaleString('en-US')})`)
    const more = never.length > DETAIL_LIMIT ? `, and ${never.length - DETAIL_LIMIT} more` : ''
    const rare = this.rarelyCalled()
    const rareListed = rare.slice(0, DETAIL_LIMIT).map(([name, n, calls]) => `${name} (${n.toLocaleString('en-US')} tokens, ${calls.toLocaleString('en-US')} ${calls === 1 ? 'call' : 'calls'})`)
    const rareMore = rare.length > DETAIL_LIMIT ? `, and ${rare.length - DETAIL_LIMIT} more` : ''
    const rareDetail = rare.length > 0 ? `Rarely called, where a stub pays, largest first: ${rareListed.join(', ')}${rareMore}.` : ''
    const idle = this.neverInvoked()
    const idleTokens = idle.reduce((sum, [, n]) => sum + n, 0)
    const idleListed = idle.slice(0, DETAIL_LIMIT).map(([name, n]) => `${name} (${n.toLocaleString('en-US')})`)
    const idleMore = idle.length > DETAIL_LIMIT ? `, and ${idle.length - DETAIL_LIMIT} more` : ''
    const idleDetail = idle.length > 0 ? `Skills never invoked, largest first (tokens per request): ${idleListed.join(', ')}${idleMore}.` : ''
    const { action, hint } = this.action(never, rare, idle)
    const neverDetail = never.length > 0 ? `Never called, largest first (tokens per request): ${listed.join(', ')}${more}.` : ''
    const detail = [neverDetail, rareDetail, idleDetail].filter(Boolean).join(' ') + hint
    return {
      ...super.getStats(),
      totalInvocations: this.requests,
      kpis: [
        { key: 'requests', label: 'Requests with a tool list', value: this.requests },
        { key: 'offered', label: 'Tools offered', value: this.offered.size },
        { key: 'called', label: 'Tools called', value: [...this.offered.keys()].filter(n => this.called.has(n)).length },
        { key: 'calls', label: 'Calls seen', value: this.calls },
        { key: 'never', label: 'Never called', value: never.length },
        { key: 'neverTokens', label: 'Their tokens per request', value: neverTokens.toLocaleString('en-US') },
        { key: 'skills', label: 'Skills listed', value: this.skills.size },
        { key: 'skillsNever', label: 'Skills never invoked', value: idle.length },
        { key: 'skillsNeverTokens', label: 'Their tokens per request', value: idleTokens.toLocaleString('en-US') },
      ],
      ...(detail ? { detail } : {}),
      ...(action ? { action } : {}),
    }
  }

  resetStats(): void {
    super.resetStats()
    this.requests = 0
    this.offered.clear()
    this.called.clear()
    this.offeredOn.clear()
    this.skills.clear()
    this.skillCalls.clear()
    this.countedCalls.clear()
    this.calls = 0
    this.changed()
  }
}
