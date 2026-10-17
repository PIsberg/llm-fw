import { describe, it, expect } from 'vitest'
import { AnsiStripModule, stripAnsi } from '../../src/modules/builtin/ansiStrip.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const ESC = '\u001b'

describe('stripAnsi', () => {
  it('removes colour and cursor sequences', () => {
    expect(stripAnsi(`${ESC}[1;31mFAIL${ESC}[0m test/a.test.ts ${ESC}[2K${ESC}[1G`)).toBe('FAIL test/a.test.ts ')
  })

  it('removes OSC hyperlinks but keeps their text', () => {
    expect(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\ and ${ESC}]0;title\u0007done`))
      .toBe('link and done')
  })

  it('removes single-character escapes and the 8-bit CSI', () => {
    expect(stripAnsi(`a${ESC}7b${ESC}8c\u009b32md`)).toBe('abcd')
  })

  it('leaves text without escapes untouched', () => {
    const text = 'plain [1;31m text with brackets ]8;; and a backslash \\'
    expect(stripAnsi(text)).toBe(text)
  })
})

describe('AnsiStripModule', () => {
  it('strips tool output and prompts, and counts the saving', () => {
    const mod = new AnsiStripModule({ enabled: true })
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `${ESC}[32m✓${ESC}[39m 12 passed` }] },
        { role: 'user', content: `see ${ESC}[1mthis${ESC}[22m` },
      ],
    })
    const parsed = JSON.parse(mod.transformRequest(body, ctx).body)
    expect(parsed.messages[0].content[0].content).toBe('✓ 12 passed')
    expect(parsed.messages[1].content).toBe('see this')
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)
  })
})
