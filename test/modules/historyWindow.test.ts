import { describe, it, expect } from 'vitest'
import { HistoryWindowModule } from '../../src/modules/builtin/historyWindow.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const chat = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }))
const cfg = (maxMessages = 60, step = 20) => ({ enabled: true, maxMessages, step })
const send = (mod: HistoryWindowModule, payload: Record<string, unknown>) => JSON.parse(mod.transformRequest(JSON.stringify(payload), ctx).body)

describe('HistoryWindowModule', () => {
  it('leaves a conversation within the window untouched', () => {
    const mod = new HistoryWindowModule(cfg())
    expect(mod.transformRequest(JSON.stringify({ messages: chat(60) }), ctx).modified).toBe(false)
  })

  it('never cuts a server-side thread continuation, whose messages are all new', () => {
    // Claude Code against api.anthropic.com sends thread: { type: 'continue' }
    // and only the turn's new messages; the server holds the history. A cut
    // there would drop content the server has never seen.
    const mod = new HistoryWindowModule(cfg(10, 10))
    const payload = { thread: { type: 'continue', previous_message_id: 'msg_1' }, messages: chat(30) }
    expect(mod.transformRequest(JSON.stringify(payload), ctx).modified).toBe(false)
  })

  it('drops the oldest messages in whole steps and says how many', () => {
    const out = send(new HistoryWindowModule(cfg()), { messages: chat(100) }).messages
    // 40 over the window, a multiple of the 20-message step.
    expect(out).toHaveLength(60)
    expect(out[0]).toEqual({ role: 'user', content: '[llm-fw: 40 earlier messages omitted]\n\nm40' })
    expect(out[59].content).toBe('m99')
  })

  it('moves the cut only once per step, so the prefix stays byte-identical in between', () => {
    const mod = new HistoryWindowModule(cfg())
    let previous: unknown[] | null = null
    for (let n = 101; n <= 120; n++) {
      const out = send(mod, { messages: chat(n) }).messages as unknown[]
      if (previous) expect(out.slice(0, previous.length)).toEqual(previous)
      previous = out
    }
  })

  it('turns the results of a dropped tool call into text when the step lands on them', () => {
    const messages = [
      ...chat(40),
      { role: 'user', content: [{ type: 'text', text: 'run it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'and now?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ...chat(20),
    ]
    // 64 messages, window 22, step 2: the step lands on index 42, the result
    // of the call at 41. The call is gone, so the result is sent as text: a
    // tool_result whose tool_use is not in the request is refused.
    const out = send(new HistoryWindowModule(cfg(22, 2)), { messages }).messages
    expect(out).toHaveLength(22)
    expect(out[0].role).toBe('user')
    expect(JSON.stringify(out[0])).not.toContain('tool_result')
    expect(out[0].content).toEqual([
      { type: 'text', text: '[llm-fw: 42 earlier messages omitted]' },
      { type: 'text', text: '[llm-fw: result of an omitted tool call]\nok' },
      { type: 'text', text: 'and now?' },
    ])
  })

  it('keeps a whole window in an agent loop that has no plain user turn after the step', () => {
    // Claude Code through the gateway: one prompt, then hundreds of tool
    // calls. The cut used to wait for the next plain user turn and so never
    // happened, or happened late and kept a handful of turns.
    const loop = Array.from({ length: 120 }, (_, i) => i % 2 === 0
      ? { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }] }
      : { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i - 1}`, content: [{ type: 'text', text: `r${i}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] }] })
    const messages = [{ role: 'user', content: 'fix the bug' }, ...loop]
    const mod = new HistoryWindowModule(cfg(100, 10))
    const out = send(mod, { messages }).messages
    // 121 messages: three steps of 10 over the window lands on index 30, a
    // tool result.
    expect(out).toHaveLength(91)
    expect(out[0].content).toEqual([
      { type: 'text', text: '[llm-fw: 30 earlier messages omitted]' },
      { type: 'text', text: '[llm-fw: result of an omitted tool call]\nr29' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
    ])
    for (const [i, m] of out.entries()) {
      for (const block of m.content) if (block.type === 'tool_result') expect(out[i - 1].content.some((b: { id?: string }) => b.id === block.tool_use_id)).toBe(true)
    }
  })

  it('cuts at the user turn after the step when the step lands on an assistant turn', () => {
    const loop = Array.from({ length: 40 }, (_, i) => i % 2 === 0
      ? { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }] }
      : { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i - 1}`, content: `r${i}` }] })
    // 41 messages, window 20, step 3: the step lands on index 21, an
    // assistant turn, so the kept history starts with the result at 22.
    const out = send(new HistoryWindowModule(cfg(20, 3)), { messages: [{ role: 'user', content: 'go' }, ...loop] }).messages
    expect(out).toHaveLength(19)
    expect(out[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '[llm-fw: 22 earlier messages omitted]' }, { type: 'text', text: '[llm-fw: result of an omitted tool call]\nr21' }] })
  })

  it('turns OpenAI chat tool messages at the cut into user messages', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      ...chat(10),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'one' },
      { role: 'tool', tool_call_id: 'c2', content: 'two' },
      ...chat(9),
    ]
    // 22 turns after the system message, window 11, step 11: the cut lands on
    // the first tool message; both answer the dropped call.
    const out = send(new HistoryWindowModule(cfg(11, 11)), { messages }).messages
    expect(out[0]).toEqual({ role: 'system', content: 'sys' })
    expect(out[1]).toEqual({ role: 'user', content: '[llm-fw: 11 earlier messages omitted]\n\n[llm-fw: result of an omitted tool call]\none' })
    expect(out[2]).toEqual({ role: 'user', content: '[llm-fw: result of an omitted tool call]\ntwo' })
    expect(out).toHaveLength(12)
  })

  it('turns a Gemini function response at the cut into text', () => {
    const contents = [
      ...Array.from({ length: 9 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'model', parts: [{ text: `c${i}` }] })),
      { role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }] },
      ...Array.from({ length: 9 }, (_, i) => ({ role: i % 2 === 0 ? 'model' : 'user', parts: [{ text: `d${i}` }] })),
    ]
    const out = send(new HistoryWindowModule(cfg(10, 10)), { contents }).contents
    expect(out).toHaveLength(10)
    expect(out[0]).toEqual({ role: 'user', parts: [{ text: '[llm-fw: 10 earlier messages omitted]' }, { text: '[llm-fw: result of an omitted tool call]\n{"name":"f","response":{"ok":true}}' }] })
  })

  it('cuts the same way on every turn of an agent loop between two steps', () => {
    const mod = new HistoryWindowModule(cfg(100, 25))
    let previous: unknown[] | null = null
    const all = [{ role: 'user', content: 'go' }, ...Array.from({ length: 160 }, (_, i) => i % 2 === 0
      ? { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }] }
      : { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i - 1}`, content: `r${i}` }] })]
    for (let n = 128; n <= 150; n += 2) {
      const out = send(mod, { messages: all.slice(0, n) }).messages as unknown[]
      if (previous) expect(out.slice(0, previous.length)).toEqual(previous)
      previous = out
    }
  })

  it('keeps leading system messages and the top-level system prompt', () => {
    const out = send(new HistoryWindowModule(cfg(10, 10)), {
      system: 'be brief',
      messages: [{ role: 'system', content: 'sys' }, { role: 'developer', content: 'dev' }, ...chat(30)],
    })
    expect(out.system).toBe('be brief')
    expect(out.messages.slice(0, 2)).toEqual([{ role: 'system', content: 'sys' }, { role: 'developer', content: 'dev' }])
    expect(out.messages).toHaveLength(12)
  })

  it('adds the marker as a text block when the first kept turn has blocks', () => {
    const messages = [...chat(20), { role: 'user', content: [{ type: 'text', text: 'hi' }] }, ...chat(9).slice(1)]
    const out = send(new HistoryWindowModule(cfg(10, 10)), { messages }).messages
    expect(out[0].content[0]).toEqual({ type: 'text', text: '[llm-fw: 20 earlier messages omitted]' })
    expect(out[0].content[1]).toEqual({ type: 'text', text: 'hi' })
  })

  it('strips thinking blocks from the turns it keeps, whose recorded prefix it changed', () => {
    const messages = [
      ...chat(20),
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'a' }] },
      ...chat(8),
    ]
    const out = send(new HistoryWindowModule(cfg(10, 10)), { messages }).messages
    expect(out[1].content).toEqual([{ type: 'text', text: 'a' }])
  })

  it('leaves the conversation alone when no user turn follows the step', () => {
    const messages = [...chat(20), { role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }]
    expect(new HistoryWindowModule(cfg(1, 21)).transformRequest(JSON.stringify({ messages }), ctx).modified).toBe(false)
  })

  it('windows Gemini contents, cutting at a user turn without a function response', () => {
    const contents = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'model', parts: [{ text: `c${i}` }] }))
    const out = send(new HistoryWindowModule(cfg(10, 10)), { contents }).contents
    expect(out).toHaveLength(10)
    expect(out[0].parts[0].text).toBe('[llm-fw: 20 earlier messages omitted]')
    expect(out[0].parts[1].text).toBe('c20')
  })

  it('counts the dropped text as saved', () => {
    const mod = new HistoryWindowModule(cfg())
    send(mod, { messages: chat(100) })
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)
  })
})
