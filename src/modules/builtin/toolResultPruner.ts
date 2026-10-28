import type { ToolResultPrunerConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'
import { minifyJsonText } from '../json.js'
import { trimSpacesAtLineEnds } from '../text.js'

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

const STACK_FRAME_RE = /^[ \t]*at [^\n]*(?:[/\\]node_modules[/\\]|node:internal[/\\]|\((?:node:|internal\/))[^\n]*$/
// `[^\r\n]*` rather than `.*`, which stops short of a CRLF line's `\r`.
const MATCH_LINE_RE = /^([^:\s]{2,240}):(\d+):(\d+:)?([^\r\n]*)\r?$/
// A file path, not a log prefix: it has a directory separator or ends in an
// extension. `2026-10-06T16:57:25Z` would otherwise read as file
// `2026-10-06T16`, line 57; whitespace (the tabs in `gh run view --log`) is
// already excluded by the pattern above.
const PATH_LIKE_RE = /(?:[/\\]|\.[A-Za-z][A-Za-z0-9]{0,9}$)/
const MIN_STACK_RUN = 2

/**
 * Collapses contiguous runs of at least `MIN_STACK_RUN` library/runtime stack
 * frames (`node_modules/`, `node:internal/`) into a single marker line, while
 * keeping application frames whole.
 */
export function collapseLibraryStackFrames(text: string): string {
  if (!text.includes('at ') || (!text.includes('node_modules') && !text.includes('node:') && !text.includes('internal/'))) return text
  const lines = text.split('\n')
  const out: string[] = []
  let changed = false
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    if (!STACK_FRAME_RE.test(line)) {
      out.push(line)
      i++
      continue
    }
    let j = i + 1
    while (j < lines.length && STACK_FRAME_RE.test(lines[j]!)) j++
    const run = j - i
    if (run >= MIN_STACK_RUN) {
      const cr = line.endsWith('\r') ? '\r' : ''
      const indent = /^[ \t]*/.exec(line)![0]
      out.push(`${indent}[llm-fw: ${run} internal/library stack frames elided]${cr}`)
      changed = true
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]!)
    }
    i = j
  }
  return changed ? out.join('\n') : text
}

/**
 * Groups contiguous `file:line:content` search/compiler lines under a single
 * `<file>:` header so the file path is not billed on every matching line.
 * Every match is kept: one dropped here comes back only by rerunning the
 * search.
 */
export function groupFileMatches(text: string): string {
  if (!text.includes(':')) return text
  const lines = text.split('\n')
  if (lines.length < 2) return text
  const out: string[] = []
  let changed = false
  for (let i = 0; i < lines.length;) {
    const m = MATCH_LINE_RE.exec(lines[i]!)
    if (!m || !PATH_LIKE_RE.test(m[1]!)) {
      out.push(lines[i]!)
      i++
      continue
    }
    const file = m[1]!
    let j = i + 1
    const matches: Array<{ lineNum: string; col: string; rest: string; cr: string }> = [
      { lineNum: m[2]!, col: m[3] ?? '', rest: m[4]!, cr: lines[i]!.endsWith('\r') ? '\r' : '' },
    ]
    while (j < lines.length) {
      const mj = MATCH_LINE_RE.exec(lines[j]!)
      if (!mj || mj[1] !== file) break
      matches.push({ lineNum: mj[2]!, col: mj[3] ?? '', rest: mj[4]!, cr: lines[j]!.endsWith('\r') ? '\r' : '' })
      j++
    }
    if (matches.length >= 2) {
      changed = true
      const cr0 = matches[0]!.cr
      out.push(`${file}:${cr0}`)
      for (const item of matches) {
        out.push(`  ${item.lineNum}:${item.col}${item.rest}${item.cr}`)
      }
    } else {
      out.push(lines[i]!)
    }
    i = j
  }
  return changed ? out.join('\n') : text
}

/**
 * Tool output, rewritten conservatively: an agent quotes a file read verbatim
 * in its next edit, so anything that changes a line it might quote makes the
 * edit miss. Each technique has its own switch.
 */
export class ToolResultPrunerModule extends SlotModule<ToolResultPrunerConfig> {
  readonly id = 'tool-result-pruner'
  readonly name = 'Tool Result Pruner'
  readonly description = 'Minifies tool output that is JSON, trims trailing whitespace, groups repeated file-path prefixes in grep/search output, and can collapse library stack frames'
  protected readonly kinds = TOOL_OUTPUT

  constructor(config?: ToolResultPrunerConfig) {
    super(config ?? { enabled: false, minifyJson: true, trimTrailing: true, collapseSpaceRuns: false, collapseStackFrames: false })
  }

  protected rewrite(text: string): string {
    if (this.cfg.minifyJson) {
      const minified = minifyJsonText(text)
      if (minified !== null) return minified
    }
    let out = text
    if (this.cfg.trimTrailing) out = trimSpacesAtLineEnds(out)
    if (this.cfg.collapseStackFrames) out = collapseLibraryStackFrames(out)
    out = groupFileMatches(out)
    // Runs of two or more only, after the indentation: a single tab after a
    // line number stays, and so does the indentation that carries structure.
    if (this.cfg.collapseSpaceRuns) out = out.replace(/(^|\n)([ \t]*)([^\n]*)/g, (_m, nl: string, indent: string, rest: string) => nl + indent + rest.replace(/[ \t]{2,}/g, ' '))
    return out
  }
}
