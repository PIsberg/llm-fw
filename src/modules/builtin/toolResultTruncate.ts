import type { ToolResultTruncateConfig } from '../../types.js'
import type { GatewayModuleContext } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { DEFAULT_CONFIG } from '../../config/config.js'
import { SlotModule } from '../base.js'
import type { SlotKind, TextSlot } from '../payload.js'
import { RememberedCalls, shellCommand, isFileRead, toolArgs } from '../toolCalls.js'

type Limits = Pick<ToolResultTruncateConfig, 'headLines' | 'tailLines' | 'maxChars'>

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/**
 * `text` with its middle replaced by a marker when it is longer than the
 * limits: first by lines (keep `headLines` and `tailLines`), then by
 * characters (keep two thirds of `maxChars` from the head and one third from
 * the tail, never splitting a surrogate pair). A zero limit is off.
 */
export function truncateMiddle(text: string, { headLines, tailLines, maxChars }: Limits): string {
  let out = text
  const head = Math.max(0, Math.floor(headLines))
  const tail = Math.max(0, Math.floor(tailLines))
  if (head + tail > 0) {
    const lines = out.split('\n')
    if (lines.length > head + tail) {
      const dropped = lines.length - head - tail
      out = [...lines.slice(0, head), `[llm-fw: ${dropped} lines elided]`, ...lines.slice(lines.length - tail)].join('\n')
    }
  }
  const max = Math.max(0, Math.floor(maxChars))
  if (max > 0 && out.length > max) {
    let keepHead = Math.floor((max * 2) / 3)
    let tailStart = out.length - (max - keepHead)
    if (keepHead > 0 && isHigh(out.charCodeAt(keepHead - 1))) keepHead--
    if (tailStart < out.length && isLow(out.charCodeAt(tailStart))) tailStart++
    out = `${out.slice(0, keepHead)}\n[llm-fw: ${tailStart - keepHead} characters elided]\n${out.slice(tailStart)}`
  }
  return out
}

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

/**
 * A build log or a full test run can be tens of thousands of tokens, re-sent
 * on every later turn. The head and tail usually carry what matters (the
 * command, the error, the summary). Lossy: the model never sees the middle.
 *
 * Results of the tools in `skipTools` stay whole, and so does a result whose
 * call ran a program in `skipCommands` (a file read through a shell tool).
 * Cutting a file read made the agent read the cut range back: in the live
 * round of 2026-10-17, Claude Code sessions took 24% more turns with this
 * module on.
 */
export class ToolResultTruncateModule extends SlotModule<ToolResultTruncateConfig> {
  readonly id = 'tool-result-truncate'
  readonly name = 'Tool Result Truncator'
  readonly description = 'Keeps the head and tail of oversized tool output, file reads aside, and replaces the middle with a marker'
  protected readonly kinds = TOOL_OUTPUT

  // Tool calls learned from responses, for thread continuations that carry
  // results without their calls.
  private readonly calls = new RememberedCalls()

  constructor(config?: ToolResultTruncateConfig) {
    super(config ?? structuredClone(DEFAULT_CONFIG.modules!.toolResultTruncate!))
  }

  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    this.calls.learn(response)
  }

  // A tool the request does not name, and no response seen here named
  // either, is cut as any other.
  protected rewrite(text: string, slot: TextSlot): string {
    const learned = slot.toolName === undefined ? this.calls.get(slot.toolCallId) : undefined
    const tool = slot.toolName ?? learned?.name
    if (tool !== undefined && this.cfg.skipTools.some(skip => tool === skip || tool.endsWith(`__${skip}`))) return text
    const command = shellCommand(toolArgs(learned ? learned.input : slot.toolInput))
    if (command !== undefined && isFileRead(command, Array.isArray(this.cfg.skipCommands) ? this.cfg.skipCommands : [])) return text
    return truncateMiddle(text, this.cfg)
  }
}
