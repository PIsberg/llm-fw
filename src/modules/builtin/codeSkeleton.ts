import type { CodeSkeletonConfig } from '../../types.js'
import type { GatewayModuleContext } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { DEFAULT_CONFIG } from '../../config/config.js'
import { SlotModule } from '../base.js'
import type { SlotKind, TextSlot } from '../payload.js'
import { RememberedCalls, toolArgs } from '../toolCalls.js'

/**
 * How a file's code is scanned: `js` (JavaScript and TypeScript: template
 * literals, regex literals), `c` (Java, C#, Go: `"""` text blocks and
 * backtick raw strings), `rust` (lifetimes, raw strings), `python` (indentation).
 */
export type Language = 'js' | 'c' | 'rust' | 'python'

const EXTENSIONS: Record<string, Language> = {
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  java: 'c', cs: 'c', go: 'c',
  rs: 'rust',
  py: 'python', pyi: 'python',
}

/** The language a path's extension names, or undefined for any other file. */
export function languageOf(path: string): Language | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? EXTENSIONS[name.slice(dot + 1).toLowerCase()] : undefined
}

interface Line {
  /** The line as it came, numbering included. */
  raw: string
  /** The line without a read tool's number prefix. */
  code: string
  /** The file's line number: the prefix's, else the position in the text. */
  number: number
}

// A read tool's line prefix: Claude Code's `     12\t` (or `12→` in older
// releases). Anchored, so it costs one pass over the digits.
const NUMBER_PREFIX = /^ *(\d{1,9})[\t→]/

function splitLines(text: string): Line[] {
  return text.split('\n').map((raw, i) => {
    const m = NUMBER_PREFIX.exec(raw)
    return m ? { raw, code: raw.slice(m[0].length), number: Number(m[1]) } : { raw, code: raw, number: i + 1 }
  })
}

const indentOf = (s: string): string => s.slice(0, s.length - s.trimStart().length)

/** An elided range: line indices, both inclusive. */
interface Cut { from: number; to: number }

function render(lines: Line[], cuts: Cut[]): string {
  if (cuts.length === 0) return lines.map(l => l.raw).join('\n')
  const out: string[] = []
  let next = 0
  for (const { from, to } of cuts) {
    for (let i = next; i < from; i++) out.push(lines[i]!.raw)
    out.push(`${indentOf(lines[from]!.code)}[llm-fw: lines ${lines[from]!.number}-${lines[to]!.number} elided, read that range for the body]`)
    next = to + 1
  }
  for (let i = next; i < lines.length; i++) out.push(lines[i]!.raw)
  return out.join('\n')
}

/**
 * `text`, a whole source file as a read tool returned it, with the body of
 * every function or method of at least `minBodyLines` lines replaced by one
 * marker line that names the elided line range. Signatures, types, imports,
 * comments outside bodies and module-level code stay, and every kept line is
 * kept byte for byte, numbering included. Text the scanner cannot make sense
 * of (unbalanced braces, an unterminated string) comes back unchanged.
 *
 * Linear in the length of `text`: a tool result is attacker-controlled and
 * this runs on the thread that serves every request.
 */
export function skeletonize(text: string, language: Language, minBodyLines: number): string {
  const lines = splitLines(text)
  const min = Math.max(1, Math.floor(minBodyLines))
  const cuts = language === 'python' ? pythonCuts(lines, min) : braceCuts(lines, language, min)
  return cuts === undefined ? text : render(lines, cuts)
}

// Words that may precede the word saying what a block is.
const MODIFIERS = new Set([
  'export', 'default', 'declare', 'public', 'private', 'protected', 'internal', 'static', 'abstract',
  'async', 'final', 'sealed', 'override', 'virtual', 'readonly', 'pub', 'unsafe', 'extern', 'const',
  'let', 'var', 'partial', 'open',
])
// Blocks whose content is a type: nothing inside is a body.
const TYPE_BLOCKS = new Set(['interface', 'type', 'enum'])
// Blocks that hold members: kept, their methods elided one by one.
const CONTAINERS = new Set(['class', 'struct', 'trait', 'impl', 'namespace', 'module', 'object', 'record', 'union', 'mod'])
// Statements with a block that is not a function body.
const CONTROL = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'with', 'match',
  'loop', 'return', 'select', 'case', 'go', 'defer', 'synchronized', 'using', 'lock', 'fixed', 'checked',
  'unchecked', 'new', 'throw', 'yield', 'await',
])
// Words after which a JavaScript `/` starts a regex literal, not a division.
const BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof'])
const OPERATOR_BEFORE_REGEX = '(,=:[!&|?{};+-*%<>~^'

const isIdent = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c)

type HeaderKind = 'body' | 'type' | 'other'

// What the code before a `{`, back to the previous `;`, `{` or `}`, makes
// of the block it opens.
function classify(header: string): HeaderKind {
  const h = header.trim()
  if (h === '') return 'other'
  const words = h.match(/[A-Za-z_$][\w$]*/g) ?? []
  let i = 0
  while (i < words.length && MODIFIERS.has(words[i]!)) i++
  const kind = words[i]
  if (kind !== undefined) {
    if (TYPE_BLOCKS.has(kind)) return 'type'
    if (CONTAINERS.has(kind) || CONTROL.has(kind)) return 'other'
  }
  if (/\bnew\s/.test(h)) return 'other'
  let depth = 0
  for (const c of h) {
    if (c === '(') depth++
    else if (c === ')' && --depth < 0) return 'other'
  }
  if (depth !== 0) return 'other'
  const close = h.lastIndexOf(')')
  if (close < 0) return h.endsWith('=>') ? 'body' : 'other'
  const rest = h.slice(close + 1).trim()
  // `f(): {` opens a return type written as a type literal.
  if (rest.endsWith(':')) return 'type'
  // `x = f() {` is no declaration; `=>` is an arrow function's.
  if (rest.replace(/=>/g, '').includes('=')) return 'other'
  return 'body'
}

interface Block { kind: 'block' | 'expr' | 'tmpl'; line: number; elide: boolean; type: boolean }

// The scan of a brace language. Undefined when the braces do not balance.
function braceCuts(lines: Line[], language: Language, min: number): Cut[] | undefined {
  const src = lines.map(l => l.code).join('\n')
  const n = src.length
  const stack: Block[] = []
  const cuts: Cut[] = []
  let line = 0
  let header = ''
  let prevSig = ''
  let lastWord = ''
  let elided = 0 // open blocks being elided: 0 or 1
  let inType = 0 // open type blocks
  let noRegexBefore = 0

  const addHeader = (s: string) => {
    header += s
    if (header.length > 1024) header = header.slice(-512)
  }
  // Skip to the end of a string or comment opened at `i`, counting lines.
  const skipTo = (from: number, end: string, escapes: boolean, stopAtNewline: boolean): number => {
    let j = from
    while (j < n) {
      const c = src[j]!
      if (escapes && c === '\\') {
        if (src[j + 1] === '\n') line++
        j += 2
        continue
      }
      if (c === '\n') {
        if (stopAtNewline) return j
        line++
      }
      if (src.startsWith(end, j)) return j + end.length
      j++
    }
    return n
  }

  let i = 0
  while (i < n) {
    const top = stack[stack.length - 1]
    const c = src[i]!

    if (top?.kind === 'tmpl') {
      if (c === '\\') {
        if (src[i + 1] === '\n') line++
        i += 2
        continue
      }
      if (c === '\n') { line++; i++; continue }
      if (c === '`') { stack.pop(); prevSig = '"'; i++; continue }
      if (c === '$' && src[i + 1] === '{') { stack.push({ kind: 'expr', line, elide: false, type: false }); i += 2; continue }
      i++
      continue
    }

    if (c === '\n') { line++; addHeader(' '); i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { addHeader(' '); i++; continue }

    const next = src[i + 1]
    if (c === '/' && next === '/') { i = skipTo(i, '\n', false, true); continue }
    if (c === '/' && next === '*') { i = skipTo(i + 2, '*/', false, false); continue }

    if (c === '"' && language === 'c' && src.startsWith('"""', i)) { i = skipTo(i + 3, '"""', true, false); addHeader('""'); prevSig = '"'; continue }
    if (c === 'r' && language === 'rust' && !isIdent(src[i - 1]) && (next === '"' || next === '#')) {
      let hashes = 0
      while (src[i + 1 + hashes] === '#') hashes++
      if (src[i + 1 + hashes] === '"') { i = skipTo(i + 2 + hashes, '"' + '#'.repeat(hashes), false, false); addHeader('""'); prevSig = '"'; continue }
    }
    if (c === '"') { i = skipTo(i + 1, '"', true, true); addHeader('""'); prevSig = '"'; continue }
    if (c === "'") {
      if (language === 'rust' && isIdent(next) && src[i + 2] !== "'") { addHeader("'"); i++; continue } // a lifetime
      i = skipTo(i + 1, "'", true, true); addHeader('""'); prevSig = '"'; continue
    }
    if (c === '`') {
      if (language === 'js') { stack.push({ kind: 'tmpl', line, elide: false, type: false }); i++; continue }
      if (language === 'c') { i = skipTo(i + 1, '`', false, false); addHeader('""'); prevSig = '"'; continue }
    }
    if (c === '/' && language === 'js' && i >= noRegexBefore && (prevSig === '' || OPERATOR_BEFORE_REGEX.includes(prevSig) || (isIdent(prevSig) && BEFORE_REGEX.has(lastWord)))) {
      // A regex literal: to the closing `/` outside a character class, on this line.
      let j = i + 1
      let inClass = false
      while (j < n && src[j] !== '\n') {
        const d = src[j]!
        if (d === '\\') { j += 2; continue }
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        j++
      }
      if (src[j] === '/') { i = j + 1; addHeader('/r/'); prevSig = '"'; continue }
      // No closing `/` on this line: no `/` before its end opens one either.
      noRegexBefore = j
    }

    if (c === '{') {
      const kind = elided > 0 || inType > 0 ? (inType > 0 ? 'type' : 'other') : classify(header)
      const elide = kind === 'body'
      const type = kind === 'type'
      stack.push({ kind: 'block', line, elide, type })
      if (elide) elided++
      if (type) inType++
      header = ''
      prevSig = '{'
      i++
      continue
    }
    if (c === '}') {
      const open = stack.pop()
      if (open === undefined) return undefined
      if (open.kind === 'expr') { i++; continue } // back into the template literal
      if (open.elide) {
        elided--
        if (line - open.line - 1 >= min) cuts.push({ from: open.line + 1, to: line - 1 })
      }
      if (open.type) inType--
      header = ''
      prevSig = '}'
      i++
      continue
    }
    if (c === ';') { header = ''; prevSig = ';'; i++; continue }

    if (isIdent(c)) {
      let j = i
      while (j < n && isIdent(src[j])) j++
      lastWord = src.slice(i, j)
      addHeader(lastWord)
      prevSig = lastWord[lastWord.length - 1]!
      i = j
      continue
    }
    addHeader(c)
    prevSig = c
    i++
  }
  if (stack.length > 0) return undefined
  return cuts.sort((a, b) => a.from - b.from)
}

// Python: a `def` and the lines indented under it. A triple-quoted string
// spans lines whatever their indentation.
function pythonCuts(lines: Line[], min: number): Cut[] {
  // Whether each line starts inside a triple-quoted string.
  const inString: boolean[] = []
  let open: string | undefined
  for (const l of lines) {
    inString.push(open !== undefined)
    const s = l.code
    for (let i = 0; i < s.length; i++) {
      if (open === undefined && s[i] === '#') break
      const q = s.startsWith('"""', i) ? '"""' : s.startsWith("'''", i) ? "'''" : undefined
      if (q === undefined) continue
      if (open === undefined) open = q
      else if (open === q) open = undefined
      else continue
      i += 2
    }
  }

  const cuts: Cut[] = []
  const indent = (i: number) => indentOf(lines[i]!.code).length
  const blank = (i: number) => lines[i]!.code.trim() === ''
  let i = 0
  while (i < lines.length) {
    const code = lines[i]!.code.trimStart()
    if (inString[i] || !(code.startsWith('def ') || code.startsWith('async def '))) { i++; continue }
    const defIndent = indent(i)
    // The signature ends on the first line where the brackets close and the code ends in `:`.
    let depth = 0
    let end = -1
    for (let j = i; j < lines.length && j < i + 50 && end < 0; j++) {
      const s = lines[j]!.code
      let quote: string | undefined
      let codeEnd = s.length // where a comment starts
      for (let k = 0; k < s.length; k++) {
        const c = s[k]!
        if (quote !== undefined) {
          if (c === '\\') k++
          else if (c === quote) quote = undefined
          continue
        }
        if (c === '#') { codeEnd = k; break }
        if (c === '"' || c === "'") quote = c
        else if (c === '(' || c === '[' || c === '{') depth++
        else if (c === ')' || c === ']' || c === '}') depth--
      }
      if (depth <= 0 && s.slice(0, codeEnd).trimEnd().endsWith(':')) end = j
    }
    if (end < 0) { i++; continue }
    // The body: every following line that is blank, deeper than the def, or inside a string.
    let last = end
    for (let j = end + 1; j < lines.length; j++) {
      if (inString[j] || blank(j) || indent(j) > defIndent) {
        if (!blank(j)) last = j
        continue
      }
      break
    }
    let from = end + 1
    while (from <= last && blank(from)) from++
    // A docstring stays: it is the function's contract.
    const first = lines[from]?.code.trimStart() ?? ''
    if (from <= last && /^[rRuUbB]{0,2}("""|''')/.test(first)) {
      let k = from
      while (k < last && inString[k + 1]) k++
      from = k + 1
      while (from <= last && blank(from)) from++
    }
    if (last - from + 1 >= min) cuts.push({ from, to: last })
    i = last + 1
  }
  return cuts
}

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])
// Arguments that make a read partial: the agent picked those lines, so they stay.
const PARTIAL = ['offset', 'limit', 'start_line', 'end_line', 'startLine', 'endLine', 'view_range', 'head', 'tail']

/**
 * The idea from contextprune (github.com/maniraja5599/contextprune): a model
 * that reads a source file often needs its signatures, not every body. Where
 * contextprune packs a repository before it is pasted, this module shortens
 * a whole-file read as it passes, keeping every signature and naming each
 * elided range, so the agent can read back exactly the body it needs.
 *
 * Off by default. On 30 days of one developer's Claude Code transcripts
 * (55,593 calls) it would have cut 51% of the 1,243 whole reads of code
 * files, 0.33% of the bill; 69 of those reads were followed by an edit of
 * the same file before any re-read, and the read those edits force costs
 * 0.23%, leaving 0.10% before any re-read the agent adds. Billed A/Bs of
 * other modules that cut file reads saw the agent read the cut text back.
 */
export class CodeSkeletonModule extends SlotModule<CodeSkeletonConfig> {
  readonly id = 'code-skeleton'
  readonly name = 'Code Skeleton'
  readonly description = 'Replaces function bodies in whole-file reads of source code with a marker naming their lines, keeping every signature'
  protected readonly kinds = TOOL_OUTPUT

  // Tool calls learned from responses, for thread continuations that carry
  // results without their calls.
  private readonly calls = new RememberedCalls()

  constructor(config?: CodeSkeletonConfig) {
    super(config ?? structuredClone(DEFAULT_CONFIG.modules!.codeSkeleton!))
  }

  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    this.calls.learn(response)
  }

  // Only a known reader's whole-file read of a known language changes: a
  // result whose call cannot be found stays whole.
  protected rewrite(text: string, slot: TextSlot): string {
    const learned = slot.toolName === undefined ? this.calls.get(slot.toolCallId) : undefined
    const tool = slot.toolName ?? learned?.name
    const tools = Array.isArray(this.cfg.tools) ? this.cfg.tools : []
    if (tool === undefined || !tools.some(t => tool === t || tool.endsWith(`__${t}`))) return text
    const args = toolArgs(learned ? learned.input : slot.toolInput)
    if (args === undefined || PARTIAL.some(k => args[k] !== undefined && args[k] !== null)) return text
    if (typeof args.mode === 'string' && args.mode !== 'full') return text
    const path = [args.file_path, args.path, args.absolute_path].find((p): p is string => typeof p === 'string')
    const language = path === undefined ? undefined : languageOf(path)
    if (language === undefined) return text
    let count = 1
    for (let i = text.indexOf('\n'); i >= 0 && count < this.cfg.minLines; i = text.indexOf('\n', i + 1)) count++
    if (count < this.cfg.minLines) return text
    return skeletonize(text, language, this.cfg.minBodyLines)
  }
}
