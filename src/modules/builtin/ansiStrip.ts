import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'

// OSC (window titles, hyperlinks) up to BEL or ST; CSI (colour, cursor, erase)
// in its 7-bit and 8-bit forms; then any other escape with its intermediate
// bytes (charset selection, save/restore cursor).
/* eslint-disable sonarjs/no-control-regex -- intentional ANSI CSI/OSC escape stripping */
// oxlint-disable-next-line no-control-regex
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI CSI/OSC escape stripping
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g
/* eslint-enable sonarjs/no-control-regex */

export function stripAnsi(text: string): string {
  return text.includes('\x1b') || text.includes('\x9b') ? text.replace(ANSI, '') : text
}

const TERMINAL_TEXT: ReadonlySet<SlotKind> = new Set(['prompt', 'tool_result'])

/**
 * Strips ANSI terminal escape codes (colour, cursor movement, window titles)
 * from prompts and tool results.
 *
 * Command output pasted or returned from a terminal carries CSI colour codes
 * around every word; each `\x1b[32m` is two or three tokens the model never
 * renders and never uses.
 */
export class AnsiStripModule extends SlotModule {
  readonly id = 'ansi-strip'
  readonly name = 'ANSI Strip'
  readonly description = 'Strips terminal colour and cursor escape codes from prompts and tool results'
  protected readonly kinds = TERMINAL_TEXT

  protected rewrite(text: string): string { return stripAnsi(text) }
}
