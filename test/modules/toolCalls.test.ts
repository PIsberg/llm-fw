import { describe, it, expect } from 'vitest'
import { RememberedCalls, continuesOnServer } from '../../src/modules/toolCalls.js'
import type { CapturedResponse } from '../../src/modules/responseTap.js'

const sse = (...events: unknown[]): CapturedResponse => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: Buffer.from(events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')),
})

describe('continuesOnServer', () => {
  it('is true for an Anthropic thread, created or continued', () => {
    expect(continuesOnServer('/v1/messages', '{"thread":{"type":"create"},"messages":[]}')).toBe(true)
    expect(continuesOnServer('/v1/messages?beta=true', '{"thread": {"type":"continue","previous_message_id":"m"}}')).toBe(true)
  })

  it('is true for any Responses API request, which the provider stores by default', () => {
    expect(continuesOnServer('/v1/responses', '{"input":"hi"}')).toBe(true)
    expect(continuesOnServer('/openai/v1/responses?api-version=1', '{"input":"hi"}')).toBe(true)
  })

  it('is false for a request that resends its history', () => {
    expect(continuesOnServer('/v1/messages', '{"messages":[{"role":"user","content":"thread"}]}')).toBe(false)
    expect(continuesOnServer('/v1/chat/completions', '{"messages":[]}')).toBe(false)
    // A key quoted inside a string is escaped, so it is not the field.
    expect(continuesOnServer('/v1/messages', JSON.stringify({ messages: [{ role: 'user', content: '"thread": {' }] }))).toBe(false)
  })
})

describe('RememberedCalls', () => {
  it('learns a streamed tool_use with its input joined from input_json_delta fragments', () => {
    const calls = new RememberedCalls()
    calls.learn(sse(
      { type: 'message_start', message: { id: 'msg_1', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a/' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'b.md"}' } },
      { type: 'message_stop' },
    ))
    expect(calls.get('toolu_1')).toEqual({ id: 'toolu_1', name: 'Read', input: '{"file_path":"/a/b.md"}' })
    expect(calls.get('toolu_2')).toBeUndefined()
  })
})
