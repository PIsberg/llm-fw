import type { ToolFilterConfig } from '../../types.js'
import type { GatewayModuleContext, ModuleStats } from '../types.js'
import { PayloadModule, estimate, type PayloadOutcome } from '../base.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

type Matcher = (name: string) => boolean

// Characters kept of each description in a shortened definition, when the
// config holds no usable number.
const DEFAULT_SHORTEN_TO = 200

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

// What a shortened definition's description ends with, so the model can tell
// a stub from a tool that has nothing more to say.
const SHORTENED = ' [llm-fw: description shortened]'
// Schema keywords whose values are schemas: a map of them, a list, or one.
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions']
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems']
const SCHEMA_ONES = ['items', 'additionalProperties', 'not', 'if', 'then', 'else']
// A schema larger than this keeps the descriptions past it.
const MAX_SCHEMA_NODES = 20_000

// The first paragraph of `text`, cut at a word once it passes `max`
// characters. indexOf and one slice: a description is the client's text, and
// megabytes of it must not hold the event loop.
function lead(text: string, max: number): string {
  const body = text.trimStart()
  let end = body.length
  for (const gap of ['\n\n', '\r\n\r\n']) {
    const at = body.indexOf(gap)
    if (at >= 0 && at < end) end = at
  }
  if (end > max) {
    end = max
    if (!/\s/.test(body[max]!)) {
      const space = body.lastIndexOf(' ', max)
      if (space > max / 2) end = space
    }
    // Never half of a surrogate pair.
    const last = body.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end--
  }
  return body.slice(0, end).trimEnd()
}

// Cuts every description in a JSON schema to its lead, in place. Walks only
// where the schema keywords put schemas, so a `default` or an `enum` value
// that happens to hold a "description" key is data and stays, as does a
// parameter that is itself named description.
function shortenSchema(root: unknown, max: number): boolean {
  let changed = false
  const stack: unknown[] = [root]
  for (let seen = 0; stack.length > 0 && seen < MAX_SCHEMA_NODES; seen++) {
    const node = stack.pop()
    if (!isObj(node)) continue
    if (typeof node.description === 'string') {
      const short = lead(node.description, max)
      if (short.length < node.description.length) {
        node.description = short
        changed = true
      }
    }
    for (const key of SCHEMA_MAPS) {
      const map = node[key]
      if (isObj(map)) for (const name of Object.keys(map)) stack.push(map[name])
    }
    for (const key of [...SCHEMA_LISTS, ...SCHEMA_ONES]) {
      const value = node[key]
      if (Array.isArray(value)) for (const schema of value) stack.push(schema)
      else if (isObj(value)) stack.push(value)
    }
  }
  return changed
}

// Cuts one tool definition to a stub, in place: the name, the schema's
// structure, types, enums and required lists stay, so a call the model makes
// from the stub is still one the client can run. False when nothing in it
// was long enough to cut.
function shortenDefinition(def: unknown, max: number): boolean {
  if (!isObj(def)) return false
  const fn = isObj(def.function) ? def.function : def
  let changed = false
  for (const key of ['input_schema', 'parameters', 'parametersJsonSchema']) {
    if (shortenSchema(fn[key], max)) changed = true
  }
  if (typeof fn.description !== 'string') return changed
  const short = lead(fn.description, max)
  if (short.length + SHORTENED.length < fn.description.length) fn.description = short + SHORTENED
  else if (changed) fn.description += SHORTENED
  else return false
  return true
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
 * Removes the tools an operator names from the tool list of a request, or
 * cuts their definitions to a stub. An agent sends every definition it has,
 * and the list sits at the front of the cached prefix, so each one is billed
 * as a cache read on every turn of every conversation, used or not.
 *
 * Depends only on the configured names and on the request, so a growing
 * conversation is sent the same tool list on every turn. A tool the request
 * still needs (forced by tool_choice, called in its history) is sent whole,
 * one that carries the client's cache breakpoint is never dropped, and a
 * request whose every tool would go is left alone.
 *
 * dropTools is for a tool a client never calls: the model cannot call what
 * it is not shown. shortenTools is for one it calls now and then: the stub
 * keeps it callable, and the whole definition comes back with the first
 * call, at the price of one cache write.
 */
export class ToolFilterModule extends PayloadModule<ToolFilterConfig> {
  readonly id = 'tool-filter'
  readonly name = 'Tool Filter'
  readonly description = 'Removes the tools you name from every request\'s tool list, or cuts their definitions to a stub until they are called, so unused definitions stop being billed on each turn'

  private dropped = 0
  private shortened = 0
  private readonly compiled = { drop: { key: '', match: null as Matcher | null }, shorten: { key: '', match: null as Matcher | null } }

  constructor(config?: ToolFilterConfig) {
    super(config ?? { enabled: false, dropTools: [], shortenTools: [], shortenTo: DEFAULT_SHORTEN_TO })
  }

  // Recompiled only when hot reload changes the list.
  private pattern(which: 'drop' | 'shorten'): Matcher | null {
    const configured = which === 'drop' ? this.cfg.dropTools : this.cfg.shortenTools
    const list = Array.isArray(configured) ? configured : []
    const key = JSON.stringify(list)
    const slot = this.compiled[which]
    if (key !== slot.key) {
      slot.key = key
      slot.match = compile(list)
    }
    return slot.match
  }

  protected apply(payload: Obj, _ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome | null {
    const dropMatches = this.pattern('drop')
    const shortenMatches = this.pattern('shorten')
    if ((!dropMatches && !shortenMatches) || !Array.isArray(payload.tools) || payload.tools.length === 0) return null
    const keep = namesInUse(payload)
    const named = (def: unknown, matches: Matcher | null): boolean => {
      const name = toolName(def)
      return matches !== null && name !== undefined && matches(name) && !keep.has(name)
    }
    const size = (def: unknown): number => estimate(JSON.stringify(def), estimates)

    // Pass 1, nothing changed yet: what goes, and what the list costs whole.
    let tokensOriginal = 0
    let tokensPruned = 0
    let removed = 0
    const kept: unknown[] = []
    const stubs: Array<{ def: unknown; whole: number }> = []
    const stays = (def: unknown, whole: number): void => {
      tokensPruned += whole
      if (named(def, shortenMatches)) stubs.push({ def, whole })
    }
    const drops = (def: unknown): boolean => named(def, dropMatches) && !(isObj(def) && 'cache_control' in def)
    for (const tool of payload.tools) {
      const decls = isObj(tool) && Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations as unknown[] : null
      if (decls) {
        const left: unknown[] = []
        for (const d of decls) {
          const n = size(d)
          tokensOriginal += n
          if (drops(d)) removed++
          else {
            stays(d, n)
            left.push(d)
          }
        }
        if (left.length > 0) kept.push(left.length === decls.length ? tool : { ...tool, functionDeclarations: left })
        continue
      }
      const n = size(tool)
      tokensOriginal += n
      if (drops(tool)) removed++
      else {
        stays(tool, n)
        kept.push(tool)
      }
    }
    // Every tool would go: the request is left as the client sent it.
    if (kept.length === 0) return { changed: false, tokensOriginal, tokensPruned: tokensOriginal }

    // Pass 2: cut the named survivors to stubs, in place.
    const configured = this.cfg.shortenTo
    const max = typeof configured === 'number' && configured > 0 ? configured : DEFAULT_SHORTEN_TO
    let cut = 0
    for (const { def, whole } of stubs) {
      if (!shortenDefinition(def, max)) continue
      cut++
      tokensPruned -= whole - size(def)
    }
    if (removed === 0 && cut === 0) return { changed: false, tokensOriginal, tokensPruned: tokensOriginal }
    payload.tools = kept
    this.dropped += removed
    this.shortened += cut
    return { changed: true, tokensOriginal, tokensPruned }
  }

  getStats(): ModuleStats {
    return {
      ...super.getStats(),
      kpis: [
        { key: 'dropped', label: 'Tool definitions removed', value: this.dropped },
        { key: 'shortened', label: 'Tool definitions shortened', value: this.shortened },
      ],
    }
  }

  resetStats(): void {
    super.resetStats()
    this.dropped = 0
    this.shortened = 0
  }
}
