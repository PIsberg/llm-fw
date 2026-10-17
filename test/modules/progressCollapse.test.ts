import { describe, it, expect } from 'vitest'
import { ProgressCollapseModule, collapseProgress } from '../../src/modules/builtin/progressCollapse.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.openai.com', method: 'POST', path: '/v1/chat/completions', isLlmRequest: true, parser: null }

describe('collapseProgress', () => {
  it('keeps only the last frame of a line redrawn with carriage returns', () => {
    expect(collapseProgress('Downloading  10%\rDownloading  55%\rDownloading 100%\ndone'))
      .toBe('Downloading 100%\ndone')
  })

  it('keeps CRLF line endings as they are', () => {
    expect(collapseProgress('one\r\ntwo\r\n')).toBe('one\r\ntwo\r\n')
    expect(collapseProgress('a 1%\ra 2%\r\nb\r\n')).toBe('a 2%\r\nb\r\n')
  })

  it('keeps the last frame that has text when a line ends in a bare carriage return', () => {
    expect(collapseProgress('[==  ]\r[====]\r')).toBe('[====]')
  })

  it('leaves text without carriage returns untouched', () => {
    const text = 'line one\nline two\n'
    expect(collapseProgress(text)).toBe(text)
  })
})

describe('ProgressCollapseModule', () => {
  it('collapses tool output and counts the saving', () => {
    const mod = new ProgressCollapseModule({ enabled: true })
    const frames = Array.from({ length: 50 }, (_, i) => `npm install ${'#'.repeat(i)}`).join('\r')
    const body = JSON.stringify({ messages: [{ role: 'tool', tool_call_id: 'c', content: frames + '\nadded 312 packages' }] })
    const parsed = JSON.parse(mod.transformRequest(body, ctx).body)
    expect(parsed.messages[0].content).toBe(`npm install ${'#'.repeat(49)}\nadded 312 packages`)
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)
  })
})
