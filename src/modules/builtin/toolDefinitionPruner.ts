import type { ModuleSwitchConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'
import { pruneText } from './tokenPruner.js'

const TOOL_DEFINITIONS: ReadonlySet<SlotKind> = new Set(['tool_definition'])

/**
 * The token pruner's whitespace rules applied to tool and parameter
 * descriptions, which an agent resends on every request. Names, enum values
 * and schema structure are never touched: they are the contract with the
 * tool.
 */
export class ToolDefinitionPrunerModule extends SlotModule {
  readonly id = 'tool-definition-pruner'
  readonly name = 'Tool Definition Pruner'
  readonly description = 'Collapses repeated spaces and blank lines in tool and parameter descriptions; names, enums and schemas are untouched'
  protected readonly kinds = TOOL_DEFINITIONS

  constructor(config?: ModuleSwitchConfig) {
    super(config ?? { enabled: false })
  }

  protected rewrite(text: string): string {
    return pruneText(text)
  }
}
