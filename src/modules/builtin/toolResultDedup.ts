import type { ToolResultDedupConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind, TextSlot } from '../payload.js'

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

/**
 * An agent rereads the same file, reruns the same command, and every copy
 * stays in the history it resends. A tool result identical to an earlier
 * one in the same request becomes a pointer to it.
 *
 * Which copy is kept depends only on what comes before it, so a history
 * that only grows is rewritten the same way on every turn and the prompt
 * cache keeps matching.
 */
export class ToolResultDedupModule extends SlotModule<ToolResultDedupConfig> {
  readonly id = 'tool-result-dedup'
  readonly name = 'Tool Result Deduplicator'
  readonly description = 'Replaces a tool result identical to an earlier one in the same conversation with a pointer to it'
  protected readonly kinds = TOOL_OUTPUT

  private seen = new Map<string, string>()
  private ordinal = 0

  constructor(config?: ToolResultDedupConfig) {
    super(config ?? { enabled: false, minLength: 200 })
  }

  protected beginRequest(): void {
    this.seen.clear()
    this.ordinal = 0
  }

  protected rewrite(text: string, slot: TextSlot): string {
    this.ordinal++
    if (text.length < this.cfg.minLength) return text
    const first = this.seen.get(text)
    if (first !== undefined) return `[llm-fw: identical to the earlier tool result ${first}]`
    this.seen.set(text, slot.toolCallId ?? `#${this.ordinal}`)
    return text
  }
}
