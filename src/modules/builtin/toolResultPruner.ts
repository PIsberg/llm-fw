import type { ToolResultPrunerConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'

/**
 * `text` with the whitespace outside JSON strings removed, or null when the
 * text is not a JSON object or array. Lexical on purpose: JSON.parse and
 * stringify would round 12345678901234567890 to 12345678901234567000 and 1.50
 * to 1.5, and an agent then quotes the wrong id back to the tool.
 */
export function minifyJsonText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    JSON.parse(trimmed)
  } catch {
    return null
  }
  let out = ''
  let inString = false
  let start = 0
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i)
    if (inString) {
      if (c === 92) i++ // backslash: skip the escaped character
      else if (c === 34) inString = false
    } else if (c === 34) {
      inString = true
    } else if (c === 32 || c === 9 || c === 10 || c === 13) {
      out += trimmed.slice(start, i)
      start = i + 1
    }
  }
  return out + trimmed.slice(start)
}

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

/**
 * Tool output, rewritten conservatively: an agent quotes a file read verbatim
 * in its next edit, so anything that changes a line it might quote makes the
 * edit miss. Each technique has its own switch.
 */
export class ToolResultPrunerModule extends SlotModule<ToolResultPrunerConfig> {
  readonly id = 'tool-result-pruner'
  readonly name = 'Tool Result Pruner'
  readonly description = 'Minifies tool output that is JSON and trims trailing whitespace; collapsing interior space runs is a separate option'
  protected readonly kinds = TOOL_OUTPUT

  constructor(config?: ToolResultPrunerConfig) {
    super(config ?? { enabled: false, minifyJson: true, trimTrailing: true, collapseSpaceRuns: false })
  }

  protected rewrite(text: string): string {
    if (this.cfg.minifyJson) {
      const minified = minifyJsonText(text)
      if (minified !== null) return minified
    }
    let out = text
    if (this.cfg.trimTrailing) out = out.replace(/[ \t]+(?=\r?\n|$)/g, '')
    // Runs of two or more only, after the indentation: a single tab after a
    // line number stays, and so does the indentation that carries structure.
    if (this.cfg.collapseSpaceRuns) out = out.replace(/(^|\n)([ \t]*)([^\n]*)/g, (_m, nl: string, indent: string, rest: string) => nl + indent + rest.replace(/[ \t]{2,}/g, ' '))
    return out
  }
}
