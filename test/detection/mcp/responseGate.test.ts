import { describe, it, expect } from 'vitest'
import { McpScanner } from '../../../src/detection/mcp/scanner.js'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'
import { getParser } from '../../../src/detection/parsers.js'
import {
  inspectJsonResponse,
  rewriteBlockedJsonResponse,
  SseToolGate,
  OpenAiSseToolGate,
  createSseGate,
} from '../../../src/detection/mcp/responseGate.js'
import type { Config } from '../../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(mcp: Partial<Config['mcp']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    mcp: { ...DEFAULT_CONFIG.mcp, ...mcp },
  }
}

function makeScanner(mcp: Partial<Config['mcp']> = {}): McpScanner {
  return new McpScanner(makeConfig(mcp), null)
}

/** Build a single SSE event string: "event: <type>\ndata: <json>\n\n" */
function sseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Build a realistic Anthropic SSE stream with:
 *   - index 0: text block
 *   - index 1: tool_use block (name configurable)
 */
function buildSseStream(toolName: string): string {
  const events: string[] = []

  // message_start
  events.push(
    sseEvent('message_start', {
      type: 'message_start',
      message: { id: 'msg_01', type: 'message', role: 'assistant', content: [], model: 'claude-3-5-sonnet-20241022', stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
    }),
  )

  // index 0: text block
  events.push(
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  )
  events.push(
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello world' } }),
  )
  events.push(
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
  )

  // index 1: tool_use block
  events.push(
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: toolName, input: {} },
    }),
  )
  events.push(
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' },
    }),
  )
  events.push(
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
  )

  // message_delta with stop_reason
  events.push(
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 42 },
    }),
  )

  // message_stop
  events.push(sseEvent('message_stop', { type: 'message_stop' }))

  return events.join('')
}

/** Text-only SSE stream (no tool_use). */
function buildTextOnlyStream(): string {
  return [
    sseEvent('message_start', { type: 'message_start', message: { id: 'msg_02', type: 'message', role: 'assistant', content: [], model: 'claude-3-5-sonnet-20241022', stop_reason: null } }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Just text' } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const mcp = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
const parser = getParser('/v1/messages')

// ---------------------------------------------------------------------------
// 1. inspectJsonResponse
// ---------------------------------------------------------------------------

describe('inspectJsonResponse', () => {
  it('parser is non-null for /v1/messages', () => {
    expect(parser).not.toBeNull()
  })

  it('returns 2 decisions (pass + block) and blockedNames={execute_command} for a mixed body', () => {
    const body = JSON.stringify({
      type: 'message',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', name: 'read_file', input: {} },
        { type: 'tool_use', name: 'execute_command', input: {} },
      ],
    })
    const { decisions, blockedNames } = inspectJsonResponse(body, parser!, mcp)
    expect(decisions).toHaveLength(2)
    const passD = decisions.find(d => d.toolName === 'read_file')
    const blockD = decisions.find(d => d.toolName === 'execute_command')
    expect(passD?.action).toBe('pass')
    expect(blockD?.action).toBe('block')
    expect(blockedNames.size).toBe(1)
    expect(blockedNames.has('execute_command')).toBe(true)
  })

  it('returns empty decisions and empty blockedNames when no tool_use present', () => {
    const body = JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'hello' }] })
    const { decisions, blockedNames } = inspectJsonResponse(body, parser!, mcp)
    expect(decisions).toHaveLength(0)
    expect(blockedNames.size).toBe(0)
  })

  it('returns empty decisions for invalid JSON (parser tolerates)', () => {
    const { decisions, blockedNames } = inspectJsonResponse('NOT JSON {{{', parser!, mcp)
    expect(decisions).toHaveLength(0)
    expect(blockedNames.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. rewriteBlockedJsonResponse
// ---------------------------------------------------------------------------

describe('rewriteBlockedJsonResponse — Anthropic mixed (one blocked, one allowed)', () => {
  const body = JSON.stringify({
    type: 'message',
    content: [
      { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: '/etc/hosts' } },
      { type: 'tool_use', id: 'tu2', name: 'execute_command', input: { cmd: 'ls' } },
    ],
    stop_reason: 'tool_use',
  })
  const blocked = new Set(['execute_command'])

  it('removes the blocked tool_use block', () => {
    const result = JSON.parse(rewriteBlockedJsonResponse(body, blocked))
    const toolUses = (result.content as Array<Record<string, unknown>>).filter(b => b.type === 'tool_use')
    expect(toolUses.every((b: Record<string, unknown>) => b.name !== 'execute_command')).toBe(true)
  })

  it('retains the allowed tool_use block', () => {
    const result = JSON.parse(rewriteBlockedJsonResponse(body, blocked))
    const toolUses = (result.content as Array<Record<string, unknown>>).filter(b => b.type === 'tool_use')
    expect(toolUses.some((b: Record<string, unknown>) => b.name === 'read_file')).toBe(true)
  })

  it('appends a text note block', () => {
    const result = JSON.parse(rewriteBlockedJsonResponse(body, blocked))
    const textBlocks = (result.content as Array<Record<string, unknown>>).filter(b => b.type === 'text')
    expect(textBlocks.length).toBeGreaterThan(0)
  })

  it('keeps stop_reason === "tool_use" when at least one tool_use remains', () => {
    const result = JSON.parse(rewriteBlockedJsonResponse(body, blocked))
    expect(result.stop_reason).toBe('tool_use')
  })
})

describe('rewriteBlockedJsonResponse — Anthropic all blocked → end_turn', () => {
  const body = JSON.stringify({
    type: 'message',
    content: [
      { type: 'tool_use', id: 'tu1', name: 'execute_command', input: {} },
    ],
    stop_reason: 'tool_use',
  })
  const blocked = new Set(['execute_command'])

  it('removes all tool_use blocks', () => {
    const result = JSON.parse(rewriteBlockedJsonResponse(body, blocked))
    const toolUses = (result.content as Array<Record<string, unknown>>).filter(b => b.type === 'tool_use')
    expect(toolUses).toHaveLength(0)
  })

  it('sets stop_reason to end_turn when no tool_use remains', () => {
    const result = JSON.parse(rewriteBlockedJsonResponse(body, blocked))
    expect(result.stop_reason).toBe('end_turn')
  })

  it('appends a text note block', () => {
    const result = JSON.parse(rewriteBlockedJsonResponse(body, blocked))
    const textBlocks = (result.content as Array<Record<string, unknown>>).filter(b => b.type === 'text')
    expect(textBlocks.length).toBeGreaterThan(0)
  })
})

describe('rewriteBlockedJsonResponse — blockedNames does not match any block', () => {
  it('returns body with content length unchanged (no note added)', () => {
    const original = {
      type: 'message',
      content: [
        { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} },
      ],
      stop_reason: 'tool_use',
    }
    const body = JSON.stringify(original)
    const result = JSON.parse(rewriteBlockedJsonResponse(body, new Set(['execute_command'])))
    expect(result.content).toHaveLength(original.content.length)
  })
})

describe('rewriteBlockedJsonResponse — Gemini body', () => {
  const body = JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            { functionCall: { name: 'execute_command', args: {} } },
            { text: 'x' },
          ],
        },
      },
    ],
  })
  const blocked = new Set(['execute_command'])

  it('removes the functionCall part', () => {
    const result = JSON.parse(rewriteBlockedJsonResponse(body, blocked))
    const parts = result.candidates[0].content.parts as Array<Record<string, unknown>>
    expect(parts.every((p: Record<string, unknown>) => !p.functionCall)).toBe(true)
  })

  it('appends a text note part', () => {
    const result = JSON.parse(rewriteBlockedJsonResponse(body, blocked))
    const parts = result.candidates[0].content.parts as Array<Record<string, unknown>>
    expect(parts.some((p: Record<string, unknown>) => typeof p.text === 'string')).toBe(true)
  })
})

describe('rewriteBlockedJsonResponse — OpenAI body', () => {
  it('drops only the blocked tool_call, keeps the allowed one', () => {
    const body = JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'execute_command', arguments: '{}' } },
            { id: 'b', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    })
    const result = JSON.parse(rewriteBlockedJsonResponse(body, new Set(['execute_command'])))
    const calls = result.choices[0].message.tool_calls as Array<Record<string, unknown>>
    expect(calls).toHaveLength(1)
    expect((calls[0]!.function as Record<string, unknown>).name).toBe('get_weather')
  })

  it('when all tool_calls are blocked, drops them, adds a note, and downgrades finish_reason', () => {
    const body = JSON.stringify({
      choices: [{
        message: { role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'execute_command', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    })
    const result = JSON.parse(rewriteBlockedJsonResponse(body, new Set(['execute_command'])))
    expect(result.choices[0].message.tool_calls).toBeUndefined()
    expect(typeof result.choices[0].message.content).toBe('string')
    expect(result.choices[0].message.content).toContain('execute_command')
    expect(result.choices[0].finish_reason).toBe('stop')
  })
})

describe('rewriteBlockedJsonResponse — edge cases', () => {
  it('returns the input string unchanged for invalid JSON', () => {
    const bad = 'NOT JSON'
    expect(rewriteBlockedJsonResponse(bad, new Set(['execute_command']))).toBe(bad)
  })

  it('returns an equivalent object for JSON with neither content nor candidates', () => {
    const original = { foo: 'bar', baz: 42 }
    const body = JSON.stringify(original)
    const result = JSON.parse(rewriteBlockedJsonResponse(body, new Set(['execute_command'])))
    expect(result).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// 3. SseToolGate
// ---------------------------------------------------------------------------

describe('SseToolGate — blocked tool (execute_command)', () => {
  it('a: decisions contain block for execute_command; execute_command events absent from forward, text events present, stop_reason rewritten to end_turn', () => {
    const gate = new SseToolGate(mcp)
    const stream = buildSseStream('execute_command')
    const { forward, decisions } = gate.push(stream)

    // Decision: block for execute_command
    expect(decisions.length).toBeGreaterThan(0)
    const blockDecision = decisions.find(d => d.toolName === 'execute_command')
    expect(blockDecision?.action).toBe('block')

    // execute_command NOT in forwarded bytes
    expect(forward).not.toContain('execute_command')

    // The index-1 delta event should be suppressed
    expect(forward).not.toContain('"partial_json"')

    // Text block events (index 0) ARE present
    expect(forward).toContain('Hello world')

    // stop_reason rewritten
    expect(forward).toContain('"stop_reason":"end_turn"')
    expect(forward).not.toContain('"stop_reason":"tool_use"')
  })
})

describe('SseToolGate — allowed tool (read_file)', () => {
  it('b: tool_use start event forwarded, decision action is pass, stop_reason left as tool_use', () => {
    const gate = new SseToolGate(mcp)
    const stream = buildSseStream('read_file')
    const { forward, decisions } = gate.push(stream)

    // Decision: pass for read_file
    const passDecision = decisions.find(d => d.toolName === 'read_file')
    expect(passDecision?.action).toBe('pass')

    // tool_use start IS forwarded (contains name read_file)
    expect(forward).toContain('read_file')

    // stop_reason NOT rewritten (no blocked tools)
    expect(forward).toContain('"stop_reason":"tool_use"')
    expect(forward).not.toContain('"stop_reason":"end_turn"')
  })
})

describe('SseToolGate — chunk-split robustness', () => {
  it('c: splitting the blocked stream into 7-char slices yields the same forward output', () => {
    // Reference: single push
    const streamA = buildSseStream('execute_command')
    const gateA = new SseToolGate(mcp)
    const singleResult = gateA.push(streamA)
    const singleForward = singleResult.forward + gateA.flush()

    // Chunked: same stream, 7-char slices
    const streamB = buildSseStream('execute_command')
    const gateB = new SseToolGate(mcp)
    let chunkedForward = ''
    for (let i = 0; i < streamB.length; i += 7) {
      const slice = streamB.slice(i, i + 7)
      chunkedForward += gateB.push(slice).forward
    }
    chunkedForward += gateB.flush()

    expect(chunkedForward).toBe(singleForward)
  })
})

describe('SseToolGate — text-only stream', () => {
  it('d: plain text-only stream is forwarded verbatim, decisions empty', () => {
    const gate = new SseToolGate(mcp)
    const stream = buildTextOnlyStream()
    const { forward, decisions } = gate.push(stream)
    expect(decisions).toHaveLength(0)
    expect(forward).toBe(stream)
  })
})

describe('SseToolGate — flush returns trailing buffer', () => {
  it('e: flush() returns buffered text that had no terminating blank line', () => {
    const gate = new SseToolGate(mcp)
    // Push an incomplete event (no trailing \n\n)
    const partial = 'event: message_start\ndata: {"type":"message_start"}'
    gate.push(partial)
    const flushed = gate.flush()
    expect(flushed).toBe(partial)
  })

  it('e2: flush() returns empty string when buffer is empty', () => {
    const gate = new SseToolGate(mcp)
    const stream = buildTextOnlyStream()
    gate.push(stream)
    // All events end with \n\n so buffer should be clear
    expect(gate.flush()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 4. OpenAiSseToolGate
// ---------------------------------------------------------------------------

/** Build a single OpenAI SSE event: "data: <json>\n\n". */
function openAiEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/**
 * Realistic OpenAI chat-completions tool-call stream:
 *   - chunk 1: assistant role + tool_call index 0 with its NAME
 *   - chunks 2-3: argument fragments for index 0
 *   - chunk 4: terminal finish_reason: 'tool_calls'
 *   - [DONE]
 */
function buildOpenAiToolStream(toolName: string): string {
  return [
    openAiEvent({ choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: '' } }] }, finish_reason: null }] }),
    openAiEvent({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd"' } }] }, finish_reason: null }] }),
    openAiEvent({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }, finish_reason: null }] }),
    openAiEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ].join('')
}

/** OpenAI text-only stream (no tool calls). */
function buildOpenAiTextStream(): string {
  return [
    openAiEvent({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] }),
    openAiEvent({ choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] }),
    openAiEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ].join('')
}

describe('OpenAiSseToolGate — blocked tool (execute_command)', () => {
  it('suppresses the call, drops argument fragments, downgrades finish_reason to stop', () => {
    const gate = new OpenAiSseToolGate(mcp)
    const { forward, decisions } = gate.push(buildOpenAiToolStream('execute_command'))

    const blockDecision = decisions.find(d => d.toolName === 'execute_command')
    expect(blockDecision?.action).toBe('block')

    // The blocked tool name and its streamed arguments never reach the agent.
    expect(forward).not.toContain('execute_command')
    expect(forward).not.toContain('cmd')

    // The assistant turn still opens (role chunk survives, tool_calls stripped).
    expect(forward).toContain('"role":"assistant"')

    // finish_reason rewritten so the agent ends cleanly instead of awaiting a tool.
    expect(forward).toContain('"finish_reason":"stop"')
    expect(forward).not.toContain('"finish_reason":"tool_calls"')

    // [DONE] sentinel is preserved.
    expect(forward).toContain('[DONE]')
  })
})

describe('OpenAiSseToolGate — allowed tool (read_file)', () => {
  it('forwards the call verbatim and leaves finish_reason as tool_calls', () => {
    const gate = new OpenAiSseToolGate(mcp)
    const { forward, decisions } = gate.push(buildOpenAiToolStream('read_file'))

    const passDecision = decisions.find(d => d.toolName === 'read_file')
    expect(passDecision?.action).toBe('pass')

    expect(forward).toContain('read_file')
    expect(forward).toContain('cmd')
    expect(forward).toContain('"finish_reason":"tool_calls"')
  })
})

describe('OpenAiSseToolGate — chunk-split robustness', () => {
  it('splitting the blocked stream into 5-char slices yields the same forward output', () => {
    const ref = new OpenAiSseToolGate(mcp)
    const single = ref.push(buildOpenAiToolStream('execute_command')).forward + ref.flush()

    const split = new OpenAiSseToolGate(mcp)
    const stream = buildOpenAiToolStream('execute_command')
    let out = ''
    for (let i = 0; i < stream.length; i += 5) out += split.push(stream.slice(i, i + 5)).forward
    out += split.flush()

    expect(out).toBe(single)
  })
})

describe('OpenAiSseToolGate — text-only stream', () => {
  it('forwards a plain text stream verbatim with no decisions', () => {
    const gate = new OpenAiSseToolGate(mcp)
    const stream = buildOpenAiTextStream()
    const { forward, decisions } = gate.push(stream)
    expect(decisions).toHaveLength(0)
    expect(forward).toBe(stream)
  })
})

describe('createSseGate — provider selection', () => {
  it('returns an OpenAI gate for an OpenAI-compatible parser', () => {
    expect(createSseGate(getParser('/v1/chat/completions')!, mcp)).toBeInstanceOf(OpenAiSseToolGate)
  })

  it('returns the Anthropic gate for the Anthropic parser', () => {
    expect(createSseGate(getParser('/v1/messages')!, mcp)).toBeInstanceOf(SseToolGate)
  })
})
