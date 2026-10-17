import type { ToolResultShuntConfig } from '../../types.js'
import { DEFAULT_CONFIG } from '../../config/config.js'
import { SlotModule } from '../base.js'
import type { SlotKind, TextSlot } from '../payload.js'

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

/**
 * Replaces a very large tool result with a short list of facts a local worker
 * model read from it, and keeps the original in a file the agent can open.
 * Stub: the module is registered and switchable, and forwards every result
 * unchanged until the shunt itself is written.
 */
export class ToolResultShuntModule extends SlotModule<ToolResultShuntConfig> {
  readonly id = 'tool-result-shunt'
  readonly name = 'Tool Result Shunt'
  readonly description = 'Replaces an oversized tool result with facts a local worker model read from it, and stores the original in a file'
  protected readonly kinds = TOOL_OUTPUT

  constructor(config?: ToolResultShuntConfig) {
    super(config ?? structuredClone(DEFAULT_CONFIG.modules!.toolResultShunt!))
  }

  protected rewrite(text: string, _slot: TextSlot): string {
    return text
  }
}
