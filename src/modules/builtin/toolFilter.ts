import type { ToolFilterConfig } from '../../types.js'
import type { GatewayModuleContext, ModuleStats } from '../types.js'
import { PayloadModule, estimate, type PayloadOutcome } from '../base.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

type Matcher = (name: string) => boolean

// `*` matches any run of characters, `__` included; the rest is literal and
// the pattern spans the whole name. Matched without a RegExp: a pattern with
// several stars compiled to `.*` runs backtracked for minutes on a long name
// that almost matched, holding the event loop. Taking each literal piece at
// its first occurrence after the previous one is enough for `*` alone, and
// stays linear in the name.
function globMatches(pieces: string[], name: string): boolean {
  if (pieces.length === 1) return name === pieces[0]
  const first = pieces[0]!
  const last = pieces[pieces.length - 1]!
  if (name.length < first.length + last.length || !name.startsWith(first) || !name.endsWith(last)) return false
  const end = name.length - last.length
  let at = first.length
  for (let i = 1; i < pieces.length - 1; i++) {
    const piece = pieces[i]!
    const found = name.indexOf(piece, at)
    if (found < 0 || found + piece.length > end) return false
    at = found + piece.length
  }
  return true
}

function compile(patterns: string[]): Matcher | null {
  const globs = patterns.filter(p => typeof p === 'string' && p !== '').map(p => p.split('*'))
  return globs.length > 0 ? name => globs.some(g => globMatches(g, name)) : null
}

/** True when `name` matches any of `patterns`, as dropTools matches. */
export function matchesAny(patterns: string[], name: string): boolean {
  return compile(patterns)?.(name) ?? false
}

// A tool's name in the Anthropic, OpenAI chat, Responses API and Gemini
// declaration shapes; a server tool without one (`{type: "web_search"}`)
// is never dropped.
export function toolName(tool: unknown): string | undefined {
  if (!isObj(tool)) return undefined
  const fn = isObj(tool.function) ? tool.function : tool
  return typeof fn.name === 'string' ? fn.name : undefined
}

// Names the request still needs: the forced tool_choice, and every tool its
// history has already called. Dropping one of those gets the request
// refused, or leaves the model a call it cannot see the tool for.
function namesInUse(payload: Obj): Set<string> {
  const used = new Set<string>()
  const choice = payload.tool_choice
  if (isObj(choice)) {
    const name = toolName(choice)
    if (name) used.add(name)
  }
  const fcc = isObj(payload.toolConfig) && isObj(payload.toolConfig.functionCallingConfig) ? payload.toolConfig.functionCallingConfig : undefined
  if (fcc && Array.isArray(fcc.allowedFunctionNames)) for (const n of fcc.allowedFunctionNames) if (typeof n === 'string') used.add(n)

  const turns = [payload.messages, payload.input, payload.contents].filter(Array.isArray).flat() as unknown[]
  for (const turn of turns) {
    if (!isObj(turn)) continue
    if (turn.type === 'function_call' && typeof turn.name === 'string') used.add(turn.name)
    if (Array.isArray(turn.tool_calls)) for (const c of turn.tool_calls) { const n = toolName(c); if (n) used.add(n) }
    const parts = Array.isArray(turn.content) ? turn.content : Array.isArray(turn.parts) ? turn.parts : []
    for (const p of parts) {
      if (!isObj(p)) continue
      if (p.type === 'tool_use' && typeof p.name === 'string') used.add(p.name)
      if (isObj(p.functionCall) && typeof p.functionCall.name === 'string') used.add(p.functionCall.name)
    }
  }
  return used
}

/**
 * Removes the tools an operator names from the tool list of a request. An
 * agent sends every definition it has, and the list sits at the front of
 * the cached prefix, so each one is billed as a cache read on every turn of
 * every conversation, used or not.
 *
 * Depends only on the configured names and on the request, so a growing
 * conversation is sent the same tool list on every turn. A tool the request
 * still needs (forced by tool_choice, called in its history) or one that
 * carries the client's cache breakpoint stays, and a request whose every
 * tool would go is left alone.
 */
export class ToolFilterModule extends PayloadModule<ToolFilterConfig> {
  readonly id = 'tool-filter'
  readonly name = 'Tool Filter'
  readonly description = 'Removes the tools you name from every request\'s tool list, so unused definitions stop being billed on each turn'

  private dropped = 0
  private compiled: { key: string, match: Matcher | null } = { key: '', match: null }

  constructor(config?: ToolFilterConfig) {
    super(config ?? { enabled: false, dropTools: [] })
  }

  // Recompiled only when hot reload changes the list.
  private pattern(): Matcher | null {
    const list = Array.isArray(this.cfg.dropTools) ? this.cfg.dropTools : []
    const key = JSON.stringify(list)
    if (key !== this.compiled.key) this.compiled = { key, match: compile(list) }
    return this.compiled.match
  }

  protected apply(payload: Obj, _ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome | null {
    const matches = this.pattern()
    if (!matches || !Array.isArray(payload.tools) || payload.tools.length === 0) return null
    const keep = namesInUse(payload)
    const drops = (def: unknown): boolean => {
      const name = toolName(def)
      return name !== undefined && matches(name) && !keep.has(name) && !(isObj(def) && 'cache_control' in def)
    }
    const size = (def: unknown): number => estimate(JSON.stringify(def), estimates)

    let tokensOriginal = 0
    let tokensPruned = 0
    let removed = 0
    const kept: unknown[] = []
    for (const tool of payload.tools) {
      const decls = isObj(tool) && Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations as unknown[] : null
      if (decls) {
        const left = decls.filter(d => !drops(d))
        for (const d of decls) tokensOriginal += size(d)
        for (const d of left) tokensPruned += size(d)
        removed += decls.length - left.length
        if (left.length > 0) kept.push(left.length === decls.length ? tool : { ...tool, functionDeclarations: left })
        continue
      }
      const n = size(tool)
      tokensOriginal += n
      if (drops(tool)) removed++
      else {
        tokensPruned += n
        kept.push(tool)
      }
    }
    if (removed === 0 || kept.length === 0) return { changed: false, tokensOriginal, tokensPruned: tokensOriginal }
    payload.tools = kept
    this.dropped += removed
    return { changed: true, tokensOriginal, tokensPruned }
  }

  getStats(): ModuleStats {
    return { ...super.getStats(), kpis: [{ key: 'dropped', label: 'Tool definitions removed', value: this.dropped }] }
  }

  resetStats(): void {
    super.resetStats()
    this.dropped = 0
  }
}
