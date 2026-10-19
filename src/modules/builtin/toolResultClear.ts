import type { ToolResultClearConfig } from '../../types.js'
import type { GatewayModuleContext, ModuleStats } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { DEFAULT_CONFIG } from '../../config/config.js'
import { PayloadModule, type PayloadOutcome } from '../base.js'
import { responseEvents } from '../usage.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const EDIT_TYPE = 'clear_tool_uses_20250919'
const isClearToolUses = (edit: unknown): boolean => isObj(edit) && typeof edit.type === 'string' && edit.type.startsWith('clear_tool_uses')

// The API refuses `context_management` without this beta (400 "Extra inputs
// are not permitted"). Claude Code sends it; a plain SDK client does not, so
// the module asks for it to be appended to whatever betas the client sent.
const BETA = 'context-management-2025-06-27'
function betaHeader(headers: GatewayModuleContext['headers']): Record<string, string> | undefined {
  const beta = headers?.['anthropic-beta']
  const list = Array.isArray(beta) ? beta.join(',') : beta ?? ''
  if (list.split(',').some(b => b.trim().startsWith('context-management-'))) return undefined
  return { 'anthropic-beta': list.trim() ? `${list},${BETA}` : BETA }
}

/**
 * Anthropic context editing, server side: once a request's input passes
 * `triggerTokens`, the API replaces the results of all but the last
 * `keepToolUses` tool calls with a placeholder before the model reads them.
 * The client keeps sending the full history; the provider bills the edited
 * one. Lossy: the model no longer sees old tool output, and may call a tool
 * again to get it back.
 *
 * `clearAtLeast` makes each clearing remove that many tokens at once. The
 * edit changes the prompt from the first cleared result onwards, so
 * clearing one result per turn would rewrite the cache every turn.
 *
 * The edit is the same on every request, so it keeps the request prefix
 * byte-identical; the server applies it the same way to the same history.
 */
export class ToolResultClearModule extends PayloadModule<ToolResultClearConfig> {
  readonly id = 'tool-result-clear'
  readonly name = 'Server-side Tool Result Clearing'
  readonly description = 'Asks Anthropic to clear old tool results from long conversations before the model reads them (context editing)'

  private marked = 0
  private wouldMark = 0
  private clientManaged = 0
  private betaAdded = 0
  private responsesCleared = 0
  private clearedTokens = 0
  private clearedToolUses = 0

  constructor(config?: ToolResultClearConfig) {
    super(config ?? structuredClone(DEFAULT_CONFIG.modules!.toolResultClear!))
  }

  protected apply(payload: Obj, ctx: GatewayModuleContext): PayloadOutcome | null {
    const path = ctx.path.split('?')[0]
    if (ctx.target !== 'api.anthropic.com' || path !== '/v1/messages' || !Array.isArray(payload.messages)) return null
    const current = payload.context_management
    if (current !== undefined && !isObj(current)) return null
    const edits: unknown = current?.edits ?? []
    if (!Array.isArray(edits)) return null
    if (edits.some(isClearToolUses)) {
      this.clientManaged++
      return null
    }
    const headers = betaHeader(ctx.headers)
    if (headers) this.betaAdded++
    const edit: Obj = {
      type: EDIT_TYPE,
      trigger: { type: 'input_tokens', value: Math.max(1, Math.floor(this.cfg.triggerTokens)) },
      keep: { type: 'tool_uses', value: Math.max(0, Math.floor(this.cfg.keepToolUses)) },
    }
    if (this.cfg.clearAtLeast > 0) edit.clear_at_least = { type: 'input_tokens', value: Math.floor(this.cfg.clearAtLeast) }
    if (this.cfg.excludeTools.length > 0) edit.exclude_tools = [...this.cfg.excludeTools]
    // After the client's own edits: the API requires a thinking edit first.
    payload.context_management = { ...current, edits: [...(edits as unknown[]), edit] }
    if (ctx.dryRun) this.wouldMark++
    else this.marked++
    return { changed: true, tokensOriginal: 0, tokensPruned: 0, ...(headers ? { headers } : {}) }
  }

  // The server reports what it cleared: on the message in a JSON response,
  // on the message_delta event in a stream.
  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    const events = responseEvents(response.body, response.headers)
    if (!events) return
    let cleared = false
    for (const event of events) {
      if (!isObj(event) || !isObj(event.context_management) || !Array.isArray(event.context_management.applied_edits)) continue
      for (const edit of event.context_management.applied_edits) {
        if (!isClearToolUses(edit)) continue
        const e = edit as Obj
        this.clearedTokens += num(e.cleared_input_tokens)
        this.clearedToolUses += num(e.cleared_tool_uses)
        cleared = true
      }
    }
    if (cleared) this.responsesCleared++
  }

  getStats(): ModuleStats {
    return {
      ...super.getStats(),
      kpis: [
        { key: 'marked', label: 'Requests marked', value: this.marked },
        { key: 'wouldMark', label: 'Would mark (observe mode)', value: this.wouldMark },
        { key: 'responsesCleared', label: 'Responses the server cleared', value: this.responsesCleared },
        { key: 'clearedTokens', label: 'Input tokens cleared, per the server', value: this.clearedTokens },
        { key: 'clearedToolUses', label: 'Tool results cleared', value: this.clearedToolUses },
        { key: 'clientManaged', label: 'Client clears its own', value: this.clientManaged },
        { key: 'betaAdded', label: 'Beta header added', value: this.betaAdded },
      ],
    }
  }

  resetStats(): void {
    super.resetStats()
    this.marked = 0
    this.wouldMark = 0
    this.clientManaged = 0
    this.betaAdded = 0
    this.responsesCleared = 0
    this.clearedTokens = 0
    this.clearedToolUses = 0
  }
}
