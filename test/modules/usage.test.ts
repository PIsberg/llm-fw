import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import { parseUsage } from '../../src/modules/usage.js'

const json = (v: unknown) => Buffer.from(JSON.stringify(v))
const sse = (events: Array<[string | null, unknown]>) =>
  Buffer.from(events.map(([event, data]) => (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n')

describe('parseUsage — Anthropic', () => {
  it('reads a non-streaming message: input is the uncached part, cache fields are separate', () => {
    expect(parseUsage(json({
      type: 'message',
      usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 55 },
    }), {})).toEqual({ inputTokens: 12, cacheWriteTokens: 300, cacheReadTokens: 4000, outputTokens: 55 })
  })

  it('reads a stream: input and cache from message_start, output from the last message_delta', () => {
    const body = sse([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 2048, output_tokens: 1 } } }],
      ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }],
      ['message_delta', { type: 'message_delta', usage: { output_tokens: 20 } }],
      ['message_delta', { type: 'message_delta', usage: { output_tokens: 42 } }],
    ])
    expect(parseUsage(body, { 'content-type': 'text/event-stream' }))
      .toEqual({ inputTokens: 9, cacheWriteTokens: 0, cacheReadTokens: 2048, outputTokens: 42 })
  })
})

describe('parseUsage — OpenAI', () => {
  it('reads chat completions: cached tokens are part of prompt_tokens', () => {
    expect(parseUsage(json({
      object: 'chat.completion',
      usage: { prompt_tokens: 1000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 768 } },
    }), {})).toEqual({ inputTokens: 232, cacheWriteTokens: 0, cacheReadTokens: 768, outputTokens: 30 })
  })

  it('reads the usage chunk of a stream sent with include_usage', () => {
    const body = sse([
      [null, { object: 'chat.completion.chunk', choices: [{ delta: { content: 'x' } }], usage: null }],
      [null, { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } }],
    ])
    expect(parseUsage(body, { 'content-type': 'text/event-stream' }))
      .toEqual({ inputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5 })
  })

  it('reads the Responses API, streaming and not', () => {
    const usage = { input_tokens: 400, output_tokens: 8, input_tokens_details: { cached_tokens: 100 } }
    const expected = { inputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 100, outputTokens: 8 }
    expect(parseUsage(json({ object: 'response', usage }), {})).toEqual(expected)
    expect(parseUsage(sse([['response.completed', { type: 'response.completed', response: { usage } }]]), { 'content-type': 'text/event-stream' }))
      .toEqual(expected)
  })
})

describe('parseUsage — Gemini', () => {
  it('reads usageMetadata, the last one in a stream', () => {
    expect(parseUsage(json({ usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 7, cachedContentTokenCount: 20 } }), {}))
      .toEqual({ inputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 20, outputTokens: 7 })
    const body = sse([
      [null, { usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 1 } }],
      [null, { usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 9 } }],
    ])
    expect(parseUsage(body, { 'content-type': 'text/event-stream' }))
      .toEqual({ inputTokens: 70, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 9 })
  })
})

describe('parseUsage — transport', () => {
  it('decodes a gzip body', () => {
    const body = zlib.gzipSync(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 } }))
    expect(parseUsage(body, { 'content-encoding': 'gzip' }))
      .toEqual({ inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 2 })
  })

  it('returns null when there is no usage to read', () => {
    expect(parseUsage(Buffer.from('not json'), {})).toBeNull()
    expect(parseUsage(json({ error: { message: 'overloaded' } }), {})).toBeNull()
    expect(parseUsage(zlib.gzipSync('x').subarray(0, 5), { 'content-encoding': 'gzip' })).toBeNull()
  })

  it('stops decoding a compressed body that expands past the cap', () => {
    // The capture is capped on the wire, but 64 MB of one byte gzips to about
    // 64 KB: without an output cap the meter inflated all of it.
    const bomb = zlib.gzipSync(Buffer.concat([Buffer.from('{"usage":{"input_tokens":1,"output_tokens":1},"pad":"'), Buffer.alloc(64 * 1024 * 1024, 48), Buffer.from('"}')]))
    for (const [encoding, body] of [['gzip', bomb], ['br', zlib.brotliCompressSync(zlib.gunzipSync(bomb))], ['deflate', zlib.deflateSync(zlib.gunzipSync(bomb))]] as const) {
      const t0 = performance.now()
      expect(parseUsage(body, { 'content-encoding': encoding }, 1024 * 1024)).toBeNull()
      expect(performance.now() - t0).toBeLessThan(2000)
    }
  }, 60_000)
})
