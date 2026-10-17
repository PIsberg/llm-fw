import type { RepeatCollapseConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'

/**
 * A run of at least `minRun` identical lines reduced to its first line and a
 * count. Lines compare exactly; blank lines are left to the whitespace
 * pruners.
 */
export function collapseRepeats(text: string, minRun: number): string {
  const min = Math.max(2, Math.floor(minRun))
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    let j = i + 1
    while (j < lines.length && lines[j] === line) j++
    const run = j - i
    if (run >= min && line.trim() !== '') {
      const cr = line.endsWith('\r') ? '\r' : ''
      out.push(line, `[llm-fw: previous line repeated ${run - 1} more times]${cr}`)
    } else {
      for (let k = i; k < j; k++) out.push(line)
    }
    i = j
  }
  return out.join('\n')
}

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

/**
 * Logs repeat themselves: a retry loop, a deprecation warning per file, a
 * polling script. Tool output only, because a user who pastes the same line
 * five times may mean it.
 */
export class RepeatCollapseModule extends SlotModule<RepeatCollapseConfig> {
  readonly id = 'repeat-collapse'
  readonly name = 'Repeated Line Collapser'
  readonly description = 'Replaces a run of identical lines in tool output with the first line and a count'
  protected readonly kinds = TOOL_OUTPUT

  constructor(config?: RepeatCollapseConfig) {
    super(config ?? { enabled: false, minRun: 3 })
  }

  protected rewrite(text: string): string {
    return collapseRepeats(text, this.cfg.minRun)
  }
}
