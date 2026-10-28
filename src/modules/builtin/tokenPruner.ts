import type { TokenPrunerConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'
import { minifyJsonText } from '../json.js'
import { trimLineEnd } from '../text.js'

export { estimateTokens } from '../tokens.js'

const stripCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)

// Minifies multiline JSON objects and arrays that open at the start of a line
// and close on a later line holding only the matching bracket. Returns the
// rewritten lines plus the indices of the minified ones, which the whitespace
// pass must leave alone (their string values may hold meaningful spaces).
//
// Linear on purpose. The first cut used a lazy regex that rescanned to the end
// of the text from every line starting with `{`, which is quadratic: 1.4 s of
// event-loop time on a 160 KB prompt of such lines. Here the next closing line
// is looked up from a table, and the total text handed to JSON.parse is capped
// at a small multiple of the input, so a prompt full of near-JSON costs at
// most a few linear passes.
function minifyEmbeddedJson(lines: string[]): { lines: string[]; json: Set<number> } {
  const n = lines.length
  const nextClose = { '}': new Int32Array(n + 1).fill(-1), ']': new Int32Array(n + 1).fill(-1) }
  for (let i = n - 1; i >= 0; i--) {
    const l = stripCr(lines[i]!)
    nextClose['}'][i] = l === '}' ? i : nextClose['}'][i + 1]!
    nextClose[']'][i] = l === ']' ? i : nextClose[']'][i + 1]!
  }

  let budget = 4 * lines.reduce((sum, l) => sum + l.length + 1, 0)
  const out: string[] = []
  const json = new Set<number>()
  let i = 0
  while (i < n) {
    const line = lines[i]!
    const open = line[0]
    if ((open === '{' || open === '[') && budget > 0) {
      const j = nextClose[open === '{' ? '}' : ']'][i + 1]!
      if (j > i) {
        const candidate = lines.slice(i, j + 1).join('\n')
        budget -= candidate.length
        // Null when it is not valid JSON: the lines stay prose.
        const minified = minifyJsonText(candidate)
        if (minified !== null) {
          json.add(out.length)
          out.push(minified)
          i = j + 1
          continue
        }
      }
    }
    out.push(line)
    i++
  }
  return { lines: out, json }
}

const TABLE_SEP_RE = /^\|(?:\s*:?-{3,}:?\s*\|)+$/

function isTableRow(trimmed: string): boolean {
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 2
}

function condenseTableLine(line: string): string {
  const indent = /^[ \t]*/.exec(line)![0]
  const rest = line.slice(indent.length)
  if (TABLE_SEP_RE.test(rest)) {
    const cells = rest.slice(1, -1).split('|').map(cell => {
      const c = cell.trim()
      return `${c.startsWith(':') ? ':' : ''}---${c.endsWith(':') ? ':' : ''}`
    })
    return `${indent}|${cells.join('|')}|`
  }
  const cells = rest.slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim())
  return `${indent}|${cells.join('|')}|`
}

function condenseMarkdownTables(lines: string[]): string[] {
  const out = [...lines]
  for (let i = 0; i < out.length;) {
    if (!isTableRow(out[i]!.trim())) { i++; continue }
    let j = i
    let hasSep = false
    while (j < out.length && isTableRow(out[j]!.trim())) {
      if (TABLE_SEP_RE.test(out[j]!.trim())) hasSep = true
      j++
    }
    if (hasSep) {
      for (let k = i; k < j; k++) out[k] = condenseTableLine(out[k]!)
    }
    i = j
  }
  return out
}

// Prose outside code fences. Leading indentation is kept: it carries meaning
// in nested markdown lists and in code pasted without a fence. Only interior
// runs of spaces and tabs collapse, trailing whitespace goes, and a run of
// blank lines shrinks to one. Markdown tables (blocks of `| ... |` lines that
// contain a separator row) have their cell padding and separator dashes
// condensed (#360).
//
// The first and last elements of the split are partial lines (they continue a
// fence's closing line, or run into the next fence's opening one), so they are
// never counted as blank lines.
function prunePlain(part: string): string {
  const { lines, json } = minifyEmbeddedJson(part.split('\n'))
  const out: string[] = []
  let blank = false
  for (let i = 0; i < lines.length; i++) {
    if (json.has(i)) {
      out.push(lines[i]!)
      blank = false
      continue
    }
    const line = stripCr(lines[i]!)
    const indent = /^[ \t]*/.exec(line)![0]
    const rest = line.slice(indent.length).replace(/[ \t]+/g, ' ').trimEnd()
    if (i === 0 || i === lines.length - 1) {
      out.push(rest === '' ? '' : indent + rest)
      continue
    }
    if (rest === '') {
      if (blank) continue
      blank = true
      out.push('')
      continue
    }
    blank = false
    out.push(indent + rest)
  }
  return condenseMarkdownTables(out).join('\n')
}

export function pruneText(text: string): string {
  if (!text) return text

  // Split by code fences: ```lang\n...```
  const fenceRegex = /(```[a-zA-Z0-9_-]*\r?\n[\s\S]*?```)/g
  const parts = text.split(fenceRegex)

  const processed = parts.map((part) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const firstLineEnd = part.indexOf('\n')
      if (firstLineEnd === -1) return part
      const header = part.slice(0, firstLineEnd)
      const code = part.slice(firstLineEnd + 1, -3)

      // Preserve indentation inside code blocks, only trim line-trailing whitespace
      const trimmedLines = code
        .split(/\r?\n/)
        .map(trimLineEnd)
        .join('\n')
      return `${header}\n${trimmedLines}\`\`\``
    }
    return prunePlain(part)
  })

  return processed.join('').trim()
}

// Prompt and system text only. Tool output is somebody else's bytes: an
// agent quotes a file read verbatim in its next edit, so collapsing a run of
// spaces there makes the edit miss. Tool output has its own modules.
const PROSE: ReadonlySet<SlotKind> = new Set(['prompt', 'system'])

export class TokenPrunerModule extends SlotModule<TokenPrunerConfig> {
  readonly id = 'token-pruner'
  readonly name = 'Token Pruner / Cost Optimizer'
  readonly description = 'Collapses repeated spaces and blank lines and minifies embedded JSON in prompt text; keeps indentation and fenced code'
  protected readonly kinds = PROSE

  constructor(config?: TokenPrunerConfig) {
    super(config ?? { enabled: false })
  }

  protected rewrite(text: string): string {
    return pruneText(text)
  }
}
