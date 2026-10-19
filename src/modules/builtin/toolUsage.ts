import fs from 'node:fs'
import { dirname } from 'node:path'
import type { ModuleSwitchConfig, ToolFilterConfig } from '../../types.js'
import type { GatewayModuleContext, ModuleAction, ModuleStats } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { PayloadModule, estimate, type PayloadOutcome } from '../base.js'
import { responseCalls } from '../toolCalls.js'
import { matchesAny, toolName } from './toolFilter.js'
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

// Calls a request's history carries, as [id, name]; Gemini calls carry no id,
// so their name stands in for one.
function historyCalls(payload: Obj): Array<[string, string]> {
  const out: Array<[string, string]> = []
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
      if (p.type === 'tool_use' && typeof p.name === 'string') out.push([idOr(p.id, p.name), p.name])
      if (isObj(p.functionCall) && typeof p.functionCall.name === 'string') out.push([`gemini:${p.functionCall.name}`, p.functionCall.name])
    }
  }
  return out
}

/**
 * Records which offered tools a client actually calls, so you know which to
 * name in the Tool Filter's dropTools. Every tool definition is billed on every
 * request, as a cache read once cached; one the model never calls is cost with
 * no use. Calls are learned from the request history and from responses,
 * because a request that continues a server-side thread (Claude Code through
 * the proxy) carries tool results without the calls. Reads only, and runs after
 * the Tool Filter and the definition pruner, so the list is what still costs.
 */
export class ToolUsageModule extends PayloadModule<ModuleSwitchConfig> {
  readonly id = 'tool-usage'
  readonly name = 'Tool Usage'
  readonly description = 'Records which offered tools get called, and lists the ones that never do with their token cost, for the Tool Filter. Changes nothing.'

  private requests = 0
  // Name to the token estimate of its definition as last offered.
  private readonly offered = new Map<string, number>()
  private readonly called = new Set<string>()
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
      for (const name of (saved.called ?? []).slice(0, MAX_TOOLS)) if (typeof name === 'string') this.called.add(name)
    } catch { /* nothing saved yet, or unreadable: start empty */ }
  }

  /** Write the totals now, if persisting. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (!this.file) return
    const saved: SavedUsage = { requests: this.requests, calls: this.calls, offered: Object.fromEntries(this.offered), called: [...this.called] }
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

  private count(id: string, name: string): void {
    if (this.countedCalls.has(id)) return
    this.countedCalls.add(id)
    if (this.countedCalls.size > MAX_CALL_IDS) this.countedCalls.delete(this.countedCalls.values().next().value!)
    this.calls++
    this.called.add(name)
    this.changed()
  }

  protected apply(payload: Obj, _ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome | null {
    const tools = offeredTools(payload)
    if (tools.length > 0) {
      this.requests++
      for (const { name, json } of tools) {
        if (!this.offered.has(name) && this.offered.size >= MAX_TOOLS) continue
        this.offered.set(name, estimate(json, estimates))
      }
      this.changed()
    }
    for (const [id, name] of historyCalls(payload)) this.count(id, name)
    return null
  }

  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    if (!this.enabled) return
    for (const call of responseCalls(response)) this.count(call.id, call.name)
  }

  private neverCalled(): Array<[string, number]> {
    return [...this.offered].filter(([name]) => !this.called.has(name)).sort((a, b) => b[1] - a[1])
  }

  // The one-click change for the Tool Filter: its current list plus every
  // never-called tool it does not match yet, offered once enough calls have
  // been seen. Undefined without a filter to write to, or nothing to add.
  private action(never: Array<[string, number]>): { action?: ModuleAction; hint: string } {
    const filter = this.filter?.()
    if (!filter) return { hint: '' }
    const dropped = Array.isArray(filter.dropTools) ? filter.dropTools : []
    const add = never.map(([name]) => name).filter(name => !matchesAny(dropped, name))
    if (add.length === 0) return { hint: '' }
    if (this.calls < MIN_EVIDENCE_CALLS) return { hint: ` The Tool Filter action appears after ${MIN_EVIDENCE_CALLS.toLocaleString('en-US')} calls (${this.calls.toLocaleString('en-US')} so far).` }
    return {
      action: {
        label: `Drop these ${add.length} tools in the Tool Filter`,
        module: 'tool-filter',
        enabled: true,
        options: { dropTools: [...dropped, ...add] },
      },
      hint: '',
    }
  }

  getStats(): ModuleStats {
    const never = this.neverCalled()
    const neverTokens = never.reduce((sum, [, n]) => sum + n, 0)
    const listed = never.slice(0, DETAIL_LIMIT).map(([name, n]) => `${name} (${n.toLocaleString('en-US')})`)
    const more = never.length > DETAIL_LIMIT ? `, and ${never.length - DETAIL_LIMIT} more` : ''
    const { action, hint } = this.action(never)
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
      ],
      ...(never.length > 0 ? { detail: `Never called, largest first (tokens per request): ${listed.join(', ')}${more}.${hint}` } : {}),
      ...(action ? { action } : {}),
    }
  }

  resetStats(): void {
    super.resetStats()
    this.requests = 0
    this.offered.clear()
    this.called.clear()
    this.countedCalls.clear()
    this.calls = 0
    this.changed()
  }
}
