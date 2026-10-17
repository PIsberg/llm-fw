import { describe, it, expect } from 'vitest'
import { ToolResultDedupModule } from '../../src/modules/builtin/toolResultDedup.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const file = 'export const x = 1\n'.repeat(40)

const assistantCall = (id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { path: 'a.ts' } }] })
const userResult = (id: string, content: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] })

function run(mod: ToolResultDedupModule, messages: unknown[]): any[] {
  return JSON.parse(mod.transformRequest(JSON.stringify({ messages }), ctx).body).messages
}

describe('ToolResultDedupModule', () => {
  it('points a repeated tool result at the first copy', () => {
    const mod = new ToolResultDedupModule({ enabled: true, minLength: 200 })
    const out = run(mod, [
      { role: 'user', content: 'read a.ts twice' },
      assistantCall('t1'), userResult('t1', file),
      assistantCall('t2'), userResult('t2', file),
      assistantCall('t3'), userResult('t3', file),
    ])
    expect(out[2].content[0].content).toBe(file)
    expect(out[4].content[0].content).toBe('[llm-fw: identical to the earlier tool result t1]')
    expect(out[6].content[0].content).toBe('[llm-fw: identical to the earlier tool result t1]')
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)
  })

  it('leaves short duplicates and different results alone', () => {
    const mod = new ToolResultDedupModule({ enabled: true, minLength: 200 })
    const messages = [
      assistantCall('t1'), userResult('t1', 'ok'),
      assistantCall('t2'), userResult('t2', 'ok'),
      assistantCall('t3'), userResult('t3', file),
      assistantCall('t4'), userResult('t4', file + 'changed'),
    ]
    expect(mod.transformRequest(JSON.stringify({ messages }), ctx).modified).toBe(false)
  })

  it('names the earlier copy by position when the format carries no id', () => {
    const mod = new ToolResultDedupModule({ enabled: true, minLength: 200 })
    const out = JSON.parse(mod.transformRequest(JSON.stringify({ messages: [
      { role: 'tool', content: file },
      { role: 'tool', content: file },
    ] }), ctx).body).messages
    expect(out[1].content).toBe('[llm-fw: identical to the earlier tool result #1]')
  })

  it('rewrites a conversation the same way on every turn, so the cached prefix holds', () => {
    // The client resends its own unmodified history each turn. If the
    // rewrite of turn N depended on anything after it, the bytes sent for
    // the same history would change and the prompt cache would miss.
    const mod = new ToolResultDedupModule({ enabled: true, minLength: 200 })
    const turn1 = [{ role: 'user', content: 'go' }, assistantCall('t1'), userResult('t1', file), assistantCall('t2'), userResult('t2', file)]
    const turn2 = [...turn1, assistantCall('t3'), userResult('t3', file), assistantCall('t4'), userResult('t4', 'other '.repeat(50))]
    const out1 = run(mod, turn1)
    const out2 = run(mod, turn2)
    expect(out2.slice(0, out1.length)).toEqual(out1)
  })

  it('reads its minimum length live', () => {
    const cfg = { enabled: true, minLength: 200 }
    const mod = new ToolResultDedupModule(cfg)
    const body = JSON.stringify({ messages: [{ role: 'tool', content: file }, { role: 'tool', content: file }] })
    expect(mod.transformRequest(body, ctx).modified).toBe(true)
    cfg.minLength = file.length + 1
    expect(mod.transformRequest(body, ctx).modified).toBe(false)
  })
})
