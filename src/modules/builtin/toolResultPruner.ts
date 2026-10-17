import type { ToolResultPrunerConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'
import { minifyJsonText } from '../json.js'
import { trimSpacesAtLineEnds } from '../text.js'

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
    if (this.cfg.trimTrailing) out = trimSpacesAtLineEnds(out)
    // Runs of two or more only, after the indentation: a single tab after a
    // line number stays, and so does the indentation that carries structure.
    if (this.cfg.collapseSpaceRuns) out = out.replace(/(^|\n)([ \t]*)([^\n]*)/g, (_m, nl: string, indent: string, rest: string) => nl + indent + rest.replace(/[ \t]{2,}/g, ' '))
    return out
  }
}
