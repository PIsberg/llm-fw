import { describe, it, expect } from 'vitest'
import { ToolResultTruncateModule, truncateMiddle } from '../../src/modules/builtin/toolResultTruncate.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

describe('truncateMiddle', () => {
  it('keeps the first and last lines and says how many were dropped', () => {
    const out = truncateMiddle(lines(1000), { headLines: 200, tailLines: 100, maxChars: 0 })
    const kept = out.split('\n')
    expect(kept).toHaveLength(301)
    expect(kept[0]).toBe('line 1')
    expect(kept[199]).toBe('line 200')
    expect(kept[200]).toBe('[llm-fw: 700 lines elided]')
    expect(kept[201]).toBe('line 901')
    expect(kept[300]).toBe('line 1000')
  })

  it('leaves output within the limits untouched', () => {
    const text = lines(300)
    expect(truncateMiddle(text, { headLines: 200, tailLines: 100, maxChars: 100_000 })).toBe(text)
  })

  it('cuts a single huge line by characters, two thirds from the head', () => {
    const text = 'a'.repeat(6000) + 'b'.repeat(6000)
    const out = truncateMiddle(text, { headLines: 200, tailLines: 100, maxChars: 3000 })
    expect(out).toBe('a'.repeat(2000) + '\n[llm-fw: 9000 characters elided]\n' + 'b'.repeat(1000))
  })

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(3000)
    const out = truncateMiddle(text, { headLines: 0, tailLines: 0, maxChars: 1001 })
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('treats a zero limit as off', () => {
    const text = lines(5000)
    expect(truncateMiddle(text, { headLines: 0, tailLines: 0, maxChars: 0 })).toBe(text)
  })
})

describe('ToolResultTruncateModule', () => {
  it('truncates tool output only, with live limits', () => {
    const cfg = { enabled: true, headLines: 10, tailLines: 5, maxChars: 0 }
    const mod = new ToolResultTruncateModule(cfg)
    const body = JSON.stringify({ messages: [
      { role: 'tool', tool_call_id: 'c', content: lines(100) },
      { role: 'user', content: lines(100) },
    ] })
    const parsed = JSON.parse(mod.transformRequest(body, ctx).body)
    expect(parsed.messages[0].content.split('\n')).toHaveLength(16)
    expect(parsed.messages[1].content).toBe(lines(100))
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)

    cfg.headLines = 0
    cfg.tailLines = 0
    expect(mod.transformRequest(body, ctx).modified).toBe(false)
  })
})
