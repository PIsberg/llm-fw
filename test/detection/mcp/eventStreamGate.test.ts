import { describe, it, expect } from 'vitest'
import { McpScanner } from '../../../src/detection/mcp/scanner.js'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'
import { encodeFrame, EventStreamDecoder } from '../../../src/detection/mcp/eventStream.js'
import { createEventStreamGate } from '../../../src/detection/mcp/eventStreamGate.js'

// #882: Bedrock's streaming endpoints answer in binary AWS event-stream
// frames, which the proxy forwarded ungated, so a blocked tool or a
// destructive command streamed by Bedrock reached the agent unchecked.

const mcp = new McpScanner(DEFAULT_CONFIG, null)
const DESTRUCTIVE = 'rm -rf / --no-preserve-root'
const CONVERSE = '/model/anthropic.claude-sonnet-4/converse-stream'
const INVOKE = '/model/anthropic.claude-sonnet-4/invoke-with-response-stream'

const frame = (type: string, payload: unknown, messageType = 'event') =>
  encodeFrame({ ':event-type': type, ':content-type': 'application/json', ':message-type': messageType }, Buffer.from(JSON.stringify(payload)))

function converseStream(name: string, args: string): Buffer {
  return Buffer.concat([
    frame('messageStart', { role: 'assistant' }),
    frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Cleaning up.' } }),
    frame('contentBlockStop', { contentBlockIndex: 0 }),
    frame('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tooluse_1', name } } }),
    frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: args.slice(0, 9) } } }),
    frame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: args.slice(9) } } }),
    frame('contentBlockStop', { contentBlockIndex: 1 }),
    frame('messageStop', { stopReason: 'tool_use' }),
    frame('metadata', { usage: { inputTokens: 5, outputTokens: 9, totalTokens: 14 }, metrics: { latencyMs: 10 } }),
  ])
}

function invokeStream(name: string, args: string): Buffer {
  const chunk = (event: Record<string, unknown>) => frame('chunk', { bytes: Buffer.from(JSON.stringify(event)).toString('base64'), p: 'abcd' })
  return Buffer.concat([
    chunk({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }),
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cleaning up.' } }),
    chunk({ type: 'content_block_stop', index: 0 }),
    chunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } }),
    chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(0, 9) } }),
    chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(9) } }),
    chunk({ type: 'content_block_stop', index: 1 }),
    chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    chunk({ type: 'message_stop' }),
  ])
}

/** Every frame of `buf` (each must be valid), as event type and text: chunk payloads decoded. */
function read(buf: Buffer): { type: string; text: string }[] {
  return new EventStreamDecoder().push(buf).map(f => {
    const p = JSON.parse(f.payload.toString()) as { bytes?: string }
    return { type: f.headers[':event-type']!, text: p.bytes ? Buffer.from(p.bytes, 'base64').toString() : f.payload.toString() }
  })
}

function run(path: string, stream: Buffer, step = stream.length) {
  const gate = createEventStreamGate(path, mcp)
  const out: Buffer[] = []
  const decisions: unknown[] = []
  for (let i = 0; i < stream.length; i += step) {
    const r = gate.push(stream.subarray(i, i + step))
    out.push(r.forward)
    decisions.push(...r.decisions)
  }
  out.push(gate.flush())
  return { out: Buffer.concat(out), decisions }
}

describe.each([['converse-stream', CONVERSE, converseStream], ['invoke-with-response-stream', INVOKE, invokeStream]])('Bedrock %s gate (#882)', (_name, path, build) => {
  it('drops a tool blocked by name, keeps the text, and ends the turn without it', () => {
    const { out, decisions } = run(path, build('execute_command', '{"command":"ls"}'))
    const frames = read(out)
    expect(frames.map(f => f.text).join('')).not.toContain('execute_command')
    expect(frames.map(f => f.text).join('')).toContain('Cleaning up.')
    expect(frames.map(f => f.text).join('')).toContain('end_turn')
    expect(frames.map(f => f.text).join('')).not.toContain('tool_use"')
    expect(decisions).toEqual([expect.objectContaining({ toolName: 'execute_command', action: 'block' })])
  })

  it('holds an execution tool and drops it when its command is destructive, in 7-byte slices too', () => {
    for (const step of [7, Number.MAX_SAFE_INTEGER]) {
      const { out } = run(path, build('Bash', JSON.stringify({ command: DESTRUCTIVE })), step)
      const text = read(out).map(f => f.text).join('')
      expect(text).not.toContain('rm -rf')
      expect(text).toContain('Cleaning up.')
    }
  })

  it('forwards a benign stream byte for byte', () => {
    const stream = build('Bash', JSON.stringify({ command: 'ls -la src' }))
    for (const step of [5, stream.length]) {
      const { out, decisions } = run(path, stream, step)
      expect(out.equals(stream)).toBe(true)
      expect(decisions).toEqual([expect.objectContaining({ toolName: 'Bash', action: 'pass' })])
    }
  })

  it('does not release a destructive command when the stream ends before its block does', () => {
    const stream = build('Bash', JSON.stringify({ command: DESTRUCTIVE }))
    const frames = new EventStreamDecoder().push(stream)
    const cut = Buffer.concat(frames.slice(0, 6).map(f => f.raw))
    const { out } = run(path, cut)
    expect(read(out).map(f => f.text).join('')).not.toContain('rm -rf')
  })
})

describe('Bedrock event-stream gate, framing (#882)', () => {
  it('passes an exception frame on, in order', () => {
    const stream = Buffer.concat([frame('messageStart', { role: 'assistant' }), frame('throttlingException', { message: 'slow down' }, 'exception')])
    const { out } = run(CONVERSE, stream)
    expect(out.equals(stream)).toBe(true)
  })

  it('stops at a frame it cannot read and reports it, rather than forward it unchecked', () => {
    const good = frame('messageStart', { role: 'assistant' })
    const bad = Buffer.from(frame('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 't', name: 'execute_command' } } }))
    bad[bad.length - 6] ^= 0xff
    const { out, decisions } = run(CONVERSE, Buffer.concat([good, bad, frame('messageStop', { stopReason: 'tool_use' })]))
    expect(out.equals(good)).toBe(true)
    expect(decisions).toEqual([expect.objectContaining({ action: 'block' })])
  })
})
