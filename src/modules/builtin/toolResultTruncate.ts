import type { ToolResultTruncateConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'

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
 * A build log, a full test run or a large file read can be tens of
 * thousands of tokens, re-sent on every later turn. The head and tail
 * usually carry what matters (the command, the error, the summary). Lossy:
 * the model never sees the middle.
 */
export class ToolResultTruncateModule extends SlotModule<ToolResultTruncateConfig> {
  readonly id = 'tool-result-truncate'
  readonly name = 'Tool Result Truncator'
  readonly description = 'Keeps the head and tail of oversized tool output and replaces the middle with a marker'
  protected readonly kinds = TOOL_OUTPUT

  constructor(config?: ToolResultTruncateConfig) {
    super(config ?? { enabled: false, headLines: 200, tailLines: 100, maxChars: 40_000 })
  }

  protected rewrite(text: string): string {
    return truncateMiddle(text, this.cfg)
  }
}
