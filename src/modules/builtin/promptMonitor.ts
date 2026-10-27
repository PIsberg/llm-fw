import { randomUUID } from 'node:crypto'
import type { GatewayModule, GatewayModuleContext, ModuleTransformResult, ModuleStats } from '../types.js'
import type { PromptMonitorConfig } from '../../types.js'
import { parsePayload } from '../base.js'
import { collectTextSlots } from '../payload.js'
import { DlpScanner } from '../../detection/dlp/scanner.js'
import { DEFAULT_CONFIG } from '../../config/config.js'

/** One prompt the user typed, as the dashboard lists it. */
export interface PromptEntry {
  id: string
  timestamp: string
  target: string
  path: string
  model: string
  /** The client the prompt came from: its address on the proxy, a tenant on the gateway. */
  session: string
  /** The prompt, secrets redacted, cut to `maxChars`. */
  text: string
  /** Length of the prompt before it was cut. */
  chars: number
  truncated: boolean
}

export interface PromptQuery {
  /** Words that must all appear in the prompt, in any case. */
  q?: string | undefined
  target?: string | undefined
  model?: string | undefined
  session?: string | undefined
  /** ISO timestamps; inclusive. */
  since?: string | undefined
  until?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export interface PromptPage {
  /** Newest first. */
  entries: PromptEntry[]
  /** Matches before paging. */
  total: number
  /** What each filter can take, across everything held. */
  facets: { targets: string[]; models: string[]; sessions: string[] }
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
// An agent appends its own notes to the user turn in a part of its own.
const injected = (text: string): boolean => text.trimStart().startsWith('<system-reminder>')

// Gemini names the model in the path, not the body.
function modelOf(payload: Record<string, unknown>, path: string): string {
  if (typeof payload.model === 'string') return payload.model
  return /\/models\/([^/:?]+)/.exec(path)?.[1] ?? ''
}

const parseTime = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const t = Date.parse(value)
  return Number.isNaN(t) ? undefined : t
}

/**
 * Keeps what the user typed, so the dashboard can list, search and filter it.
 * Reads requests only and changes nothing.
 *
 * It stores the newest user message of each request, and only when nothing
 * follows it: an agent resends the whole conversation after every tool
 * result, so a prompt followed by a tool result or an assistant turn was
 * stored when it was first sent. Telling a resend by "same as the client's
 * last prompt" fails when two sessions share an address and alternate. Tool
 * results, system text and assistant turns are never stored. Prompts are held in memory only, run through the DLP
 * redactor first whatever the DLP mode is, cut to `maxChars`, and dropped
 * when the module is switched off or the process stops.
 */
export class PromptMonitorModule implements GatewayModule {
  readonly id = 'prompt-monitor'
  readonly name = 'Prompt Monitor'
  readonly description = 'Keeps the prompts users type in memory, redacted, so the Prompts tab can search and filter them. Off by default; switching it off forgets them. Changes nothing.'

  // The live config object, so hot reload and the dashboard toggle reach it.
  private readonly cfg: PromptMonitorConfig
  private readonly dlp = new DlpScanner(DEFAULT_CONFIG.dlp)

  // Oldest first.
  private held: PromptEntry[] = []
  private recorded = 0

  constructor(config?: PromptMonitorConfig) {
    this.cfg = config ?? { enabled: false, maxEntries: 500, maxChars: 4000 }
  }

  get enabled(): boolean {
    return this.cfg.enabled
  }

  set enabled(value: boolean) {
    this.cfg.enabled = value
    this.forgetIfOff()
  }

  // Hot reload writes the config object and never reaches the setter, so
  // every entry point checks the switch itself.
  private forgetIfOff(): boolean {
    if (this.cfg.enabled) return false
    if (this.held.length > 0) this.clear()
    return true
  }

  transformRequest(body: string, ctx: GatewayModuleContext): ModuleTransformResult {
    const unchanged = { body, modified: false }
    if (this.forgetIfOff() || !ctx.isLlmRequest) return unchanged
    const payload = parsePayload(body)
    if (!payload) return unchanged

    const slots = collectTextSlots(payload)
    let at = slots.length - 1
    while (at >= 0 && !(slots[at]!.kind === 'prompt' && slots[at]!.role === 'user' && slots[at]!.text.trim() !== '' && !injected(slots[at]!.text))) at--
    if (at < 0) return unchanged
    // Something after the prompt means the client is carrying it forward.
    if (slots.slice(at + 1).some(s => s.kind === 'tool_result' || (s.kind === 'prompt' && s.role !== 'user'))) return unchanged
    const text = slots[at]!.text
    const session = ctx.tenant ?? ctx.sessionKey ?? 'unknown'

    const clean = this.dlp.redact(text, this.dlp.scan(text))
    const maxChars = Math.max(1, this.cfg.maxChars)
    this.held.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      target: ctx.target,
      path: ctx.path,
      model: modelOf(payload, ctx.path),
      session,
      text: clean.slice(0, maxChars),
      chars: text.length,
      truncated: clean.length > maxChars,
    })
    this.recorded++
    const excess = this.held.length - Math.max(1, this.cfg.maxEntries)
    if (excess > 0) this.held.splice(0, excess)
    return unchanged
  }

  /** The held prompts that match, newest first, one page of them. */
  query(q: PromptQuery): PromptPage {
    if (this.forgetIfOff()) return { entries: [], total: 0, facets: { targets: [], models: [], sessions: [] } }
    const words = (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const since = parseTime(q.since)
    const until = parseTime(q.until)
    const matches: PromptEntry[] = []
    const targets = new Set<string>()
    const models = new Set<string>()
    const sessions = new Set<string>()
    for (let i = this.held.length - 1; i >= 0; i--) {
      const e = this.held[i]!
      targets.add(e.target)
      if (e.model) models.add(e.model)
      sessions.add(e.session)
      if (q.target && e.target !== q.target) continue
      if (q.model && e.model !== q.model) continue
      if (q.session && e.session !== q.session) continue
      if (since !== undefined || until !== undefined) {
        const t = Date.parse(e.timestamp)
        if ((since !== undefined && t < since) || (until !== undefined && t > until)) continue
      }
      if (words.length > 0) {
        const lower = e.text.toLowerCase()
        if (!words.every(w => lower.includes(w))) continue
      }
      matches.push(e)
    }
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = Math.max(q.offset ?? 0, 0)
    return {
      entries: matches.slice(offset, offset + limit),
      total: matches.length,
      facets: { targets: [...targets], models: [...models], sessions: [...sessions] },
    }
  }

  /** Forget every held prompt; the switch is left alone. */
  clear(): void {
    this.held = []
  }

  getStats(): ModuleStats {
    this.forgetIfOff()
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      totalInvocations: this.recorded,
      tokensOriginal: 0,
      tokensPruned: 0,
      tokensSaved: 0,
      percentSaved: 0,
      recentEvents: [],
      kpis: [
        { key: 'held', label: 'Prompts held', value: this.held.length },
        { key: 'recorded', label: 'Recorded since reset', value: this.recorded },
      ],
      detail: 'Memory only, secrets redacted. Open the Prompts tab to search them.',
    }
  }

  resetStats(): void {
    this.recorded = 0
  }
}
