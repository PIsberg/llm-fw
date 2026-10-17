import type { ToolResultTruncateConfig } from '../../types.js'
import type { GatewayModuleContext } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { DEFAULT_CONFIG } from '../../config/config.js'
import { SlotModule } from '../base.js'
import type { SlotKind, TextSlot } from '../payload.js'
import { responseEvents } from '../usage.js'

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

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// Tool names remembered from responses. A thread continuation answers the
// calls of the response just before it, so this covers many sessions at once.
const MAX_REMEMBERED = 4096

/**
 * [id, name] of every tool call in a response's events: Anthropic tool_use
 * blocks (a whole message, or content_block_start events) and Responses API
 * function_call items (a whole response, response.completed, or the
 * output_item events). OpenAI chat and Gemini resend every call with its
 * result, so the request itself names the tool.
 */
function toolCalls(events: unknown[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const event of events) {
    if (!isObj(event)) continue
    const response = isObj(event.response) ? event.response : event
    const items = Array.isArray(event.content) ? event.content
      : Array.isArray(response.output) ? response.output
      : [event.content_block, event.item]
    for (const item of items) {
      if (!isObj(item) || typeof item.name !== 'string') continue
      if (item.type === 'tool_use' && typeof item.id === 'string') out.push([item.id, item.name])
      else if (item.type === 'function_call' && typeof item.call_id === 'string') out.push([item.call_id, item.name])
    }
  }
  return out
}

/**
 * A build log or a full test run can be tens of thousands of tokens, re-sent
 * on every later turn. The head and tail usually carry what matters (the
 * command, the error, the summary). Lossy: the model never sees the middle.
 *
 * Results of the tools in `skipTools` stay whole. Cutting a file read made
 * the agent read the cut range back: in the live round of 2026-10-17,
 * Claude Code sessions took 24% more turns with this module on.
 */
export class ToolResultTruncateModule extends SlotModule<ToolResultTruncateConfig> {
  readonly id = 'tool-result-truncate'
  readonly name = 'Tool Result Truncator'
  readonly description = 'Keeps the head and tail of oversized tool output, file reads aside, and replaces the middle with a marker'
  protected readonly kinds = TOOL_OUTPUT

  // Tool call id to tool name, learned from responses, oldest first. A
  // request that continues a server-side thread (Claude Code through the
  // proxy, the Responses API with previous_response_id) carries tool results
  // without the calls, which the provider keeps. Ids are unique per call, so
  // one map serves every client: a forged id only decides whether the
  // forger's own result is cut.
  private readonly names = new Map<string, string>()

  constructor(config?: ToolResultTruncateConfig) {
    super(config ?? structuredClone(DEFAULT_CONFIG.modules!.toolResultTruncate!))
  }

  observeResponse(_requestBody: string, _ctx: GatewayModuleContext, response: CapturedResponse): void {
    for (const [id, name] of toolCalls(responseEvents(response.body, response.headers) ?? [])) {
      this.names.delete(id)
      this.names.set(id, name)
      if (this.names.size > MAX_REMEMBERED) this.names.delete(this.names.keys().next().value!)
    }
  }

  // A tool the request does not name, and no response seen here named
  // either, is cut as any other.
  protected rewrite(text: string, slot: TextSlot): string {
    const tool = slot.toolName ?? (slot.toolCallId === undefined ? undefined : this.names.get(slot.toolCallId))
    if (tool !== undefined && this.cfg.skipTools.some(skip => tool === skip || tool.endsWith(`__${skip}`))) return text
    return truncateMiddle(text, this.cfg)
  }
}
