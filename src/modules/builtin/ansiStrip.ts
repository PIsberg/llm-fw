import type { ModuleSwitchConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'

// OSC (window titles, hyperlinks) up to BEL or ST; CSI (colour, cursor, erase)
// in its 7-bit and 8-bit forms; then any other escape with its intermediate
// bytes (charset selection, save/restore cursor).
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g

export function stripAnsi(text: string): string {
  return text.includes('\x1b') || text.includes('\x9b') ? text.replace(ANSI, '') : text
}

const TERMINAL_TEXT: ReadonlySet<SlotKind> = new Set(['prompt', 'tool_result'])

/**
 * Terminal escape sequences in tool output and pasted prompts: colour codes
 * from test runners and linters, cursor movement, hyperlinks. They cost
 * tokens and carry nothing a model can use.
 */
export class AnsiStripModule extends SlotModule {
  readonly id = 'ansi-strip'
  readonly name = 'ANSI Escape Stripper'
  readonly description = 'Removes terminal colour, cursor and hyperlink escape sequences from tool output and prompts'
  protected readonly kinds = TERMINAL_TEXT

  constructor(config?: ModuleSwitchConfig) {
    super(config ?? { enabled: false })
  }

  protected rewrite(text: string): string {
    return stripAnsi(text)
  }
}
