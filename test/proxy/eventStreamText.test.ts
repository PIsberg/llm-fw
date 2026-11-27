import { describe, it, expect } from 'vitest'
import { encodeFrame } from '../../src/detection/mcp/eventStream.js'
import { EventStreamReader, eventStreamException, eventStreamKind } from '../../src/proxy/eventStreamText.js'
import { sseStreamText } from '../../src/proxy/canary.js'
import { extractToolCallsFromSse } from '../../src/detection/toolUseScan.js'
import { EventStreamDecoder } from '../../src/detection/mcp/eventStream.js'

// #906: Bedrock's converse-stream and invoke-with-response-stream answer in
// binary event-stream frames, and every response scan but the MCP gate read
// nothing of them. The reader turns each frame into the Anthropic SSE event
// it stands for, which the scans already read.

const event = (type: string, payload: unknown) => encodeFrame({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, Buffer.from(JSON.stringify(payload)))
const chunk = (anthropicEvent: unknown) => event('chunk', { bytes: Buffer.from(JSON.stringify(anthropicEvent)).toString('base64') })

describe('eventStreamKind', () => {
  it('names the Bedrock streaming paths and nothing else', () => {
    expect(eventStreamKind('/model/anthropic.claude-sonnet-4/converse-stream')).toBe('converse')
    expect(eventStreamKind('/model/m/invoke-with-response-stream?x=1')).toBe('invoke')
    expect(eventStreamKind('/model/m/converse')).toBeNull()
    expect(eventStreamKind('/v1/messages')).toBeNull()
  })
})

describe('EventStreamReader', () => {
  it('reads Converse text, reasoning and tool-call deltas as Anthropic events', () => {
    const r = new EventStreamReader('converse')
    const bytes = Buffer.concat([
      event('messageStart', { role: 'assistant' }),
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Here is ' } }),
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'the answer.' } }),
      event('contentBlockDelta', { contentBlockIndex: 1, delta: { reasoningContent: { text: 'thinking it over' } } }),
      event('contentBlockStart', { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tu1', name: 'fetch' } } }),
      event('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: '{"url":"https://ex' } } }),
      event('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: 'ample.com/x"}' } } }),
      event('contentBlockStop', { contentBlockIndex: 2 }),
      event('messageStop', { stopReason: 'tool_use' }),
    ])
    // Split mid-frame: frames are returned only once whole.
    const a = r.push(bytes.subarray(0, 50))
    const b = r.push(bytes.subarray(50))
    expect(a.frames.length + b.frames.length).toBe(9)
    const sse = [...a.sse, ...b.sse].join('')
    expect(sseStreamText(sse)).toContain('Here is the answer.')
    expect(sseStreamText(sse)).toContain('thinking it over')
    const calls = extractToolCallsFromSse(sse)
    expect(calls.map(c => c.toolName)).toEqual(['fetch'])
    expect(JSON.stringify(calls[0]?.args)).toContain('https://example.com/x')
    expect(Buffer.concat([...a.frames, ...b.frames].map(f => f.raw)).equals(bytes)).toBe(true)
  })

  it('reads an InvokeModel chunk as the Anthropic event it carries, and other models\' text fields', () => {
    const r = new EventStreamReader('invoke')
    const out = r.push(Buffer.concat([
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude says hi' } }),
      chunk({ outputText: 'Titan says hi' }),
      chunk({ generation: 'Llama says hi' }),
    ]))
    const text = sseStreamText(out.sse.join(''))
    expect(text).toContain('Claude says hi')
    expect(text).toContain('Titan says hi')
    expect(text).toContain('Llama says hi')
  })

  // Security review of #906: other models nest their text, and a chunk shape
  // nobody mapped must still be read.
  it('reads Nova, Mistral and Cohere chunks, and every string of an unknown chunk shape', () => {
    const r = new EventStreamReader('invoke')
    const out = r.push(Buffer.concat([
      chunk({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Nova text' } } }),
      chunk({ contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't1', name: 'fetch' } } } }),
      chunk({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"url":"https://example.com"}' } } } }),
      chunk({ contentBlockStop: { contentBlockIndex: 1 } }),
      chunk({ outputs: [{ text: 'Mistral text', stop_reason: null }] }),
      chunk({ generations: [{ text: 'Cohere text' }] }),
      chunk({ newModel: { pieces: [{ value: 'Unmapped text' }] } }),
    ]))
    const sse = out.sse.join('')
    const text = sseStreamText(sse)
    for (const t of ['Nova text', 'Mistral text', 'Cohere text', 'Unmapped text']) expect(text).toContain(t)
    expect(extractToolCallsFromSse(sse).map(c => c.toolName)).toEqual(['fetch'])
  })

  it('reports a frame it cannot read, and returns the frames before it', () => {
    const r = new EventStreamReader('converse')
    const good = event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'ok' } })
    const bad = Buffer.from(event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'x' } }))
    bad[bad.length - 1] ^= 0xff
    const out = r.push(Buffer.concat([good, bad]))
    expect(out.frames).toHaveLength(1)
    expect(out.error).toMatch(/checksum/)
  })

  it('skips exception and unknown frames without failing', () => {
    const r = new EventStreamReader('converse')
    const exc = encodeFrame({ ':message-type': 'exception', ':exception-type': 'throttlingException', ':content-type': 'application/json' }, Buffer.from('{"message":"slow down"}'))
    const out = r.push(Buffer.concat([exc, event('metadata', { usage: {} })]))
    expect(out.frames).toHaveLength(2)
    expect(out.error).toBeNull()
  })
})

describe('eventStreamException', () => {
  it('is a readable exception frame naming the reason', () => {
    const [f] = new EventStreamDecoder().push(eventStreamException('llm-fw cut this response'))
    expect(f?.headers[':message-type']).toBe('exception')
    expect(f?.headers[':exception-type']).toBe('modelStreamErrorException')
    expect(JSON.parse(f!.payload.toString('utf8')).message).toBe('llm-fw cut this response')
  })
})
