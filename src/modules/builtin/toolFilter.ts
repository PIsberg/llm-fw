import type { ToolFilterConfig } from '../../types.js'
import type { GatewayModuleContext, ModuleStats } from '../types.js'
import { PayloadModule, estimate, type PayloadOutcome } from '../base.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

type Matcher = (name: string) => boolean

// Characters kept of each description in a shortened definition, when the
// config holds no usable number.
const DEFAULT_SHORTEN_TO = 200
// The tool Claude Code invokes a skill through, and how many requests may
// offer it without a skill listing in sight before the card says so.
const SKILL_TOOL = 'Skill'
const UNLISTED_REQUESTS = 20

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

// Claude Code lists the installed skills in text it writes itself: a
// sentence, a blank line, then one `- name: description` entry per skill (a
// description can run over several lines, and an entry can be a bare name),
// up to the next blank line. In Claude Code 2.1.321 it sits in a system
// message; older versions sent it as a reminder in a user message.
//
// The sentence is a template in Claude Code's bundle, and these are its
// parts (2.1.321): lead, "also " for a listing that adds to an earlier one,
// one of two middles (the second for a client that loads skills from
// scripts), and for an adding listing the note that it is not the full
// list. `npm run client-tags -- --check` reads a release's bundle and fails
// when a part is gone, which the weekly Client Tags workflow runs.
export const SKILL_LISTING = {
  lead: 'The following skills are ',
  also: 'also ',
  middles: [
    'available for use with the Skill tool',
    'available; a script loads one with `await tools.Skill({skill: "name"})`, and its instructions arrive as a message right after the script\'s result',
  ],
  adds: '. This list adds to the skills listed earlier in this conversation and is not the full list',
} as const

// Where the entries of the skill listing in `text` begin, or -1. Each place
// the lead occurs is checked once, against a fixed number of fixed strings.
function listingStart(text: string): number {
  for (let at = text.indexOf(SKILL_LISTING.lead); at >= 0; at = text.indexOf(SKILL_LISTING.lead, at + 1)) {
    let pos = at + SKILL_LISTING.lead.length
    if (text.startsWith(SKILL_LISTING.also, pos)) pos += SKILL_LISTING.also.length
    const middle = SKILL_LISTING.middles.find(m => text.startsWith(m, pos))
    if (middle === undefined) continue
    pos += middle.length
    if (text.startsWith(SKILL_LISTING.adds, pos)) pos += SKILL_LISTING.adds.length
    if (text.startsWith(':\n\n', pos)) return pos + 3
  }
  return -1
}

/** One skill of a listing: its name, and where its lines are in the text. */
export interface SkillEntry {
  name: string
  start: number
  end: number
}

/**
 * The entries of the skill listing in `text`, in order, or null when the
 * text holds no listing in the shape above. Each entry ends where the next
 * begins; the last one ends at the blank line that closes the listing.
 * indexOf and one pass over the listing's lines.
 */
export function parseSkillListing(text: string): SkillEntry[] | null {
  const from = listingStart(text)
  if (from < 0) return null
  const blank = text.indexOf('\n\n', from)
  const stop = blank < 0 ? text.length : blank
  const entries: SkillEntry[] = []
  let line = from
  while (line < stop) {
    const newline = text.indexOf('\n', line)
    const lineEnd = newline < 0 || newline > stop ? stop : newline
    const next = Math.min(lineEnd + 1, stop)
    if (text.startsWith('- ', line)) {
      const colon = text.indexOf(': ', line + 2)
      entries.push({ name: text.slice(line + 2, colon >= 0 && colon < lineEnd ? colon : lineEnd), start: line, end: next })
    } else if (entries.length > 0) entries[entries.length - 1]!.end = next
    // Text before the first entry: not the listing this knows.
    else return null
    line = lineEnd + 1
  }
  return entries.length > 0 ? entries : null
}

/**
 * The texts of a request where the client's own skill listing can be: a
 * system message, or a user message's reminder. Never text a person typed,
 * the model wrote or a tool returned, where the same sentence is content.
 */
export function* skillListingSlots(payload: Obj): Generator<{ text: string; set: (text: string) => void }> {
  if (!Array.isArray(payload.messages)) return
  for (const message of payload.messages as unknown[]) {
    if (!isObj(message) || (message.role !== 'system' && message.role !== 'user')) continue
    const mine = (text: string): boolean => message.role === 'system' || text.startsWith('<system-reminder>')
    if (typeof message.content === 'string') {
      if (mine(message.content)) yield { text: message.content, set: text => { message.content = text } }
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as unknown[]) {
      if (isObj(block) && block.type === 'text' && typeof block.text === 'string' && mine(block.text)) {
        yield { text: block.text, set: text => { block.text = text } }
      }
    }
  }
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
 *
 * dropSkills does for Claude Code's skill listing what dropTools does for
 * the tool list: the listing is sent with every conversation and read back
 * on every call, one entry per installed skill. A dropped skill is one the
 * model no longer knows it can invoke; a person can still run it by name,
 * which the client handles. The listing never changes mid-conversation, an
 * invoked skill's entry included, so no turn pays a cache write for it.
 */
export class ToolFilterModule extends PayloadModule<ToolFilterConfig> {
  readonly id = 'tool-filter'
  readonly name = 'Tool Filter'
  readonly description = 'Removes the tools you name from every request\'s tool list, or cuts their definitions to a stub until they are called, and removes the skills you name from Claude Code\'s skill listing, so unused definitions stop being billed on each turn'

  private dropped = 0
  private shortened = 0
  private skillsDropped = 0
  // While dropSkills is set: listings found in the format this knows, and
  // requests that offered the Skill tool and carried none.
  private skillListings = 0
  private skillToolRequests = 0
  private readonly compiled = {
    drop: { key: '', match: null as Matcher | null },
    shorten: { key: '', match: null as Matcher | null },
    skills: { key: '', match: null as Matcher | null },
  }

  constructor(config?: ToolFilterConfig) {
    super(config ?? { enabled: false, dropTools: [], shortenTools: [], shortenTo: DEFAULT_SHORTEN_TO, dropSkills: [] })
  }

  // Recompiled only when hot reload changes the list.
  private pattern(which: 'drop' | 'shorten' | 'skills'): Matcher | null {
    const configured = which === 'drop' ? this.cfg.dropTools : which === 'shorten' ? this.cfg.shortenTools : this.cfg.dropSkills
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
    const tools = this.filterTools(payload, estimates)
    const skills = this.filterSkills(payload, estimates)
    if (!tools && !skills) return null
    return {
      changed: (tools?.changed ?? false) || (skills?.changed ?? false),
      tokensOriginal: (tools?.tokensOriginal ?? 0) + (skills?.tokensOriginal ?? 0),
      tokensPruned: (tools?.tokensPruned ?? 0) + (skills?.tokensPruned ?? 0),
    }
  }

  // Removes the named skills from the client's skill listing. The saving is
  // counted on the listing's entries, like the tool list's on its definitions.
  private filterSkills(payload: Obj, estimates: Map<string, number>): PayloadOutcome | null {
    const matches = this.pattern('skills')
    if (!matches) return null
    let tokensOriginal = 0
    let tokensPruned = 0
    let removed = 0
    let listings = 0
    for (const slot of skillListingSlots(payload)) {
      const entries = parseSkillListing(slot.text)
      if (!entries) continue
      listings++
      const first = entries[0]!.start
      const last = entries[entries.length - 1]!.end
      const listing = slot.text.slice(first, last)
      const whole = estimate(listing, estimates)
      tokensOriginal += whole
      const kept = entries.filter(entry => !matches(entry.name))
      // Nothing named here, or every skill would go: left as the client sent it.
      if (kept.length === entries.length || kept.length === 0) {
        tokensPruned += whole
        continue
      }
      let rest = kept.map(entry => slot.text.slice(entry.start, entry.end)).join('')
      // The last entry carried no line break of its own; nor does its stand-in.
      if (!listing.endsWith('\n') && rest.endsWith('\n')) rest = rest.slice(0, -1)
      slot.set(slot.text.slice(0, first) + rest + slot.text.slice(last))
      tokensPruned += estimate(rest, estimates)
      removed += entries.length - kept.length
    }
    this.skillListings += listings
    // A client that offers the Skill tool lists its skills somewhere.
    if (listings === 0 && Array.isArray(payload.tools) && payload.tools.some(t => toolName(t) === SKILL_TOOL)) this.skillToolRequests++
    if (tokensOriginal === 0) return null
    this.skillsDropped += removed
    return { changed: removed > 0, tokensOriginal, tokensPruned }
  }

  private filterTools(payload: Obj, estimates: Map<string, number>): PayloadOutcome | null {
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
        { key: 'skillsDropped', label: 'Skill listing entries removed', value: this.skillsDropped },
      ],
      // dropSkills that removes nothing breaks nothing, so nothing else would say.
      ...(this.skillListings === 0 && this.skillToolRequests >= UNLISTED_REQUESTS
        ? { detail: `dropSkills is set, ${this.skillToolRequests.toLocaleString('en-US')} requests offered the Skill tool and none carried a skill listing in the wording this version knows. A Claude Code release may have changed it: nothing is being removed.` }
        : {}),
    }
  }

  resetStats(): void {
    super.resetStats()
    this.dropped = 0
    this.shortened = 0
    this.skillsDropped = 0
    this.skillListings = 0
    this.skillToolRequests = 0
  }
}
