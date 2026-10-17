import type { ToolResultShuntConfig } from '../../types.js'
import { DEFAULT_CONFIG } from '../../config/config.js'
import { SlotModule } from '../base.js'
import type { SlotKind, TextSlot } from '../payload.js'
import { StoredOriginals } from '../shuntStore.js'

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

/** Why a tool result was forwarded whole, in the order data-model.md "Eligibility" decides them. */
export type WholeReason =
  | 'below-threshold'
  | 'excluded-tool'
  | 'tool-unknown'
  | 'too-large'
  | 'remote-client'
  | 'flagged'
  | 'worker-failed'
  | 'rejected'
  | 'store-failed'
  | 'store-full'

/**
 * Steps 1 to 6 of data-model.md "Eligibility": the reason this result stays
 * whole, or null when it may be condensed. Stub: not written yet.
 */
export function eligibility(
  _name: string | undefined,
  _input: unknown,
  _text: string,
  _cfg: ToolResultShuntConfig,
  _remoteAddress: string | undefined,
): WholeReason | null {
  throw new Error('eligibility is not implemented')
}

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

  /** Runs after detection and DLP, in `ModuleManager.transformScreened`, because it must know what they made of each result. */
  readonly afterScreening = true

  /** The folder of originals this module replaced, capped by `maxStoreMB` (read at each write, so a hot reload applies). */
  readonly store = new StoredOriginals(() => this.cfg.maxStoreMB * 1_048_576)

  constructor(config?: ToolResultShuntConfig) {
    super(config ?? structuredClone(DEFAULT_CONFIG.modules!.toolResultShunt!))
  }

  protected rewrite(text: string, _slot: TextSlot): string {
    return text
  }
}
