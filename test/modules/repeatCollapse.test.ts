import { describe, it, expect } from 'vitest'
import { RepeatCollapseModule, collapseRepeats } from '../../src/modules/builtin/repeatCollapse.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }

describe('collapseRepeats', () => {
  it('keeps the first of a run of identical lines and says how many followed', () => {
    expect(collapseRepeats('start\nWARN retry\nWARN retry\nWARN retry\nWARN retry\nend', 3))
      .toBe('start\nWARN retry\n[llm-fw: previous line repeated 3 more times]\nend')
  })

  it('leaves a run shorter than the minimum alone', () => {
    const text = 'a\nx\nx\nb'
    expect(collapseRepeats(text, 3)).toBe(text)
  })

  it('compares whole lines exactly, whitespace included', () => {
    const text = 'x\nx \nx'
    expect(collapseRepeats(text, 3)).toBe(text)
  })

  it('leaves runs of blank lines to the whitespace pruners', () => {
    const text = 'a\n\n\n\n\nb'
    expect(collapseRepeats(text, 3)).toBe(text)
  })

  it('collapses a run at the end of the text', () => {
    expect(collapseRepeats('a\nz\nz\nz', 3)).toBe('a\nz\n[llm-fw: previous line repeated 2 more times]')
  })
})

describe('RepeatCollapseModule', () => {
  const body = (content: string) => JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content }, { type: 'text', text: 'same\nsame\nsame\nsame' }] }],
  })

  it('collapses tool output only, with the live minimum', () => {
    const cfg = { enabled: true, minRun: 3 }
    const mod = new RepeatCollapseModule(cfg)
    const run4 = 'ok\nok\nok\nok'
    const parsed = JSON.parse(mod.transformRequest(body(run4), ctx).body)
    expect(parsed.messages[0].content[0].content).toBe('ok\n[llm-fw: previous line repeated 3 more times]')
    expect(parsed.messages[0].content[1].text).toBe('same\nsame\nsame\nsame')

    cfg.minRun = 5
    expect(mod.transformRequest(body(run4), ctx).modified).toBe(false)
  })
})
