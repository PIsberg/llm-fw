import { describe, it, expect } from 'vitest'
import { ToolResultDedupModule } from '../../src/modules/builtin/toolResultDedup.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const file = 'export const x = 1\n'.repeat(40)

const assistantCall = (id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { path: 'a.ts' } }] })
const userResult = (id: string, content: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] })

function run(mod: ToolResultDedupModule, messages: unknown[]): any[] {
  return JSON.parse((mod.transformRequest(JSON.stringify({ messages }), ctx) as { body: string }).body).messages
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
    expect((mod.transformRequest(JSON.stringify({ messages }), ctx) as { modified: boolean }).modified).toBe(false)
  })

  it('names the earlier copy by position when the format carries no id', () => {
    const mod = new ToolResultDedupModule({ enabled: true, minLength: 200 })
    const out = JSON.parse((mod.transformRequest(JSON.stringify({ messages: [
      { role: 'tool', content: file },
      { role: 'tool', content: file },
    ] }), ctx) as { body: string }).body).messages
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
    expect((mod.transformRequest(body, ctx) as { modified: boolean }).modified).toBe(true)
    cfg.minLength = file.length + 1
    expect((mod.transformRequest(body, ctx) as { modified: boolean }).modified).toBe(false)
  })

  it('deduplicates repeated <system-reminder> blocks in prompt and tool_result slots', () => {
    const mod = new ToolResultDedupModule({ enabled: true, minLength: 200 })
    const reminder = '<system-reminder>\nCurrent git status: clean\n</system-reminder>'
    const out = run(mod, [
      { role: 'user', content: `Hello ${reminder}` },
      assistantCall('t1'),
      userResult('t1', `Result 1 ${reminder}`),
      { role: 'user', content: `Follow up ${reminder}` },
    ])
    expect(out[0].content).toBe(`Hello ${reminder}`)
    expect(out[2].content[0].content).toBe('Result 1 [llm-fw: identical system-reminder omitted]')
    expect(out[3].content).toBe('Follow up [llm-fw: identical system-reminder omitted]')
  })

  it('deduplicates across server-side thread continuations via observeResponse', () => {
    const mod = new ToolResultDedupModule({ enabled: true, minLength: 200 })
    const req1 = JSON.stringify({
      thread: { type: 'create' },
      messages: [assistantCall('t1'), userResult('t1', file)],
    })
    const res1 = mod.transformRequest(req1, ctx) as { body: string; modified: boolean }
    expect(res1.modified).toBe(false)

    mod.observeResponse(res1.body, ctx, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ id: 'msg_turn1', type: 'message', content: [] })),
    })

    const req2 = JSON.stringify({
      thread: { type: 'continue', previous_message_id: 'msg_turn1' },
      messages: [userResult('t2', file)],
    })
    const res2 = mod.transformRequest(req2, ctx) as { body: string; modified: boolean }
    expect(res2.modified).toBe(true)
    const parsed2 = JSON.parse(res2.body)
    expect(parsed2.messages[0].content[0].content).toBe('[llm-fw: identical to the earlier tool result t1]')
  })

  // observeResponse gets the body that went upstream, after every later
  // module and DLP redaction: the chain must not depend on it matching the
  // body this module produced.
  it('keeps the thread chain when a later stage rewrote the body that went upstream', () => {
    const mod = new ToolResultDedupModule({ enabled: true, minLength: 200 })
    const turn1: GatewayModuleContext = { ...ctx }
    const res1 = mod.transformRequest(JSON.stringify({
      thread: { type: 'create' },
      messages: [assistantCall('t1'), userResult('t1', file)],
    }), turn1) as { body: string }
    const upstream = JSON.stringify({ ...JSON.parse(res1.body), cache_control: { type: 'ephemeral' } })
    mod.observeResponse(upstream, turn1, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ id: 'msg_turn1', type: 'message', content: [] })),
    })

    const res2 = mod.transformRequest(JSON.stringify({
      thread: { type: 'continue', previous_message_id: 'msg_turn1' },
      messages: [userResult('t2', file)],
    }), { ...ctx }) as { body: string }
    expect(JSON.parse(res2.body).messages[0].content[0].content).toBe('[llm-fw: identical to the earlier tool result t1]')
  })

  it('does not chain a response to another request\'s state', () => {
    const mod = new ToolResultDedupModule({ enabled: true, minLength: 200 })
    const a: GatewayModuleContext = { ...ctx }
    const b: GatewayModuleContext = { ...ctx }
    mod.transformRequest(JSON.stringify({ thread: { type: 'create' }, messages: [assistantCall('t1'), userResult('t1', file)] }), a)
    mod.transformRequest(JSON.stringify({ thread: { type: 'create' }, messages: [{ role: 'user', content: 'hi' }] }), b)
    // b's response arrives first and is chained to b's state, which has not seen the file.
    mod.observeResponse('{}', b, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ id: 'msg_b', type: 'message', content: [] })),
    })
    const res = mod.transformRequest(JSON.stringify({
      thread: { type: 'continue', previous_message_id: 'msg_b' },
      messages: [userResult('t2', file)],
    }), { ...ctx }) as { body: string; modified: boolean }
    expect(res.modified).toBe(false)
  })
})
