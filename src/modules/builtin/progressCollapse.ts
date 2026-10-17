import type { ModuleSwitchConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'

/**
 * Each line reduced to the last frame a terminal would have left on screen:
 * a progress bar redrawn with bare carriage returns keeps only its final
 * state. A CR that ends a CRLF line is a line ending, not a redraw.
 */
export function collapseProgress(text: string): string {
  if (!text.includes('\r')) return text
  const lines = text.split('\n')
  return lines.map((line, i) => {
    const crlf = i < lines.length - 1 && line.endsWith('\r')
    const body = crlf ? line.slice(0, -1) : line
    if (!body.includes('\r')) return line
    const frames = body.split('\r')
    let last = ''
    for (let k = frames.length - 1; k >= 0; k--) {
      if (frames[k] !== '') { last = frames[k]!; break }
    }
    return crlf ? last + '\r' : last
  }).join('\n')
}

const TERMINAL_TEXT: ReadonlySet<SlotKind> = new Set(['prompt', 'tool_result'])

/**
 * Progress bars and spinners captured from a terminal (npm, pip, docker,
 * curl) arrive as every frame they drew, joined by carriage returns. Only
 * the last frame was ever visible.
 */
export class ProgressCollapseModule extends SlotModule {
  readonly id = 'progress-collapse'
  readonly name = 'Progress Bar Collapser'
  readonly description = 'Keeps only the last frame of lines redrawn with carriage returns (progress bars, spinners)'
  protected readonly kinds = TERMINAL_TEXT

  constructor(config?: ModuleSwitchConfig) {
    super(config ?? { enabled: false })
  }

  protected rewrite(text: string): string {
    return collapseProgress(text)
  }
}
