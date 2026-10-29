import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canaryToken, injectCanary, CanaryWatch } from '../../src/proxy/canary.js'
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
