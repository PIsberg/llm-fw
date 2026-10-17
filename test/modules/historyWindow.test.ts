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

  it('cuts only at a plain user turn, never between a tool call and its result', () => {
    const messages = [
      ...chat(40),
      { role: 'user', content: [{ type: 'text', text: 'run it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ...chat(20),
    ]
    // 64 messages, window 22, step 2: the step lands on index 42, a tool
    // result, and the cut moves on past the assistant turn to the next plain
    // user turn at 44.
    const out = send(new HistoryWindowModule(cfg(22, 2)), { messages }).messages
    expect(out[0].role).toBe('user')
    expect(JSON.stringify(out[0])).not.toContain('tool_result')
    expect(out[0].content).toBe('[llm-fw: 44 earlier messages omitted]\n\nm0')
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

  it('leaves the conversation alone when no plain user turn follows the step', () => {
    const messages = [
      ...chat(20),
      ...Array.from({ length: 20 }, (_, i) => i % 2 === 0
        ? { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: {} }] }
        : { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i - 1}`, content: 'r' }] }),
    ]
    expect(new HistoryWindowModule(cfg(10, 10)).transformRequest(JSON.stringify({ messages: messages.slice(1) }), ctx).modified).toBe(false)
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
