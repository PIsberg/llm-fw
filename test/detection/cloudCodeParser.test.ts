import { describe, it, expect } from 'vitest'
import { CloudCodeParser, GeminiParser, getParser, parsers } from '../../src/detection/parsers.js'
import { extractToolCallsFromSse } from '../../src/detection/toolUseScan.js'
import { rewriteBlockedJsonResponse } from '../../src/detection/mcp/responseGate.js'

// #594: Antigravity, Gemini CLI and Gemini Code Assist send their turns to
// Google's Cloud Code API (cloudcode-pa.googleapis.com and daily-cloudcode-pa),
// not to the Gemini API. The body wraps a Gemini generateContent request in
// `request`, and every response (buffered or one SSE event) wraps a Gemini
// response in `response`. Without a parser the proxy forwarded the turn with
// only an "unrecognized endpoint" warning.

const p = new CloudCodeParser()

const envelope = (request: unknown) => JSON.stringify({
  model: 'gemini-3-pro',
  project: 'example-project-123',
  user_prompt_id: 'abc',
  request,
})

const turn = {
  systemInstruction: { role: 'user', parts: [{ text: 'You are Antigravity, a coding agent.' }] },
  contents: [
    { role: 'user', parts: [{ text: 'list the files in src' }] },
    { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'list_dir', args: { path: 'src' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'list_dir', response: { output: 'a.ts\nb.ts' } } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] },
  ],
  tools: [{ functionDeclarations: [{ name: 'list_dir', description: 'List a directory' }] }],
}

describe('getParser: Cloud Code paths', () => {
  it('returns the Cloud Code parser for generateContent and streamGenerateContent', () => {
    expect(getParser('/v1internal:generateContent')).toBeInstanceOf(CloudCodeParser)
    expect(getParser('/v1internal:streamGenerateContent?alt=sse')).toBeInstanceOf(CloudCodeParser)
  })

  it('reads a variant spelling the canonical form resolves, so it is not passed through unscanned', () => {
    expect(getParser('/v1internal%3AstreamGenerateContent?alt=sse')).toBeInstanceOf(CloudCodeParser)
    expect(getParser('//v1internal:generateContent')).toBeInstanceOf(CloudCodeParser)
  })

  it('leaves the account and quota endpoints unparsed', () => {
    expect(getParser('/v1internal:loadCodeAssist')).toBeNull()
    expect(getParser('/v1internal:countTokens')).toBeNull()
  })

  it('does not take the Gemini API paths', () => {
    expect(getParser('/v1beta/models/gemini-pro:generateContent')).not.toBeInstanceOf(CloudCodeParser)
    expect(getParser('/v1beta/models/gemini-pro:generateContent')).toBeInstanceOf(GeminiParser)
  })

  it('is registered', () => {
    expect(parsers.some(x => x instanceof CloudCodeParser)).toBe(true)
  })
})

describe('CloudCodeParser: request envelope', () => {
  const body = envelope(turn)

  it('reads the user turns and the system instruction inside `request`', () => {
    const prompts = p.extractPrompts(body)
    expect(prompts).toContain('list the files in src')
    expect(prompts).toContain('You are Antigravity, a coding agent.')
  })

  it('separates the system instruction', () => {
    expect(p.extractSystem(body)).toEqual(['You are Antigravity, a coding agent.'])
  })

  it('reads the tool declarations', () => {
    expect(p.extractTools(body)).toEqual(turn.tools)
  })

  it('reads a tool result and pairs it with the call that produced it', () => {
    const results = p.extractToolResults(body)
    expect(results).toHaveLength(1)
    expect(results[0]!.result).toContain('a.ts')
    expect(results[0]!.toolName).toBe('list_dir')
    expect(results[0]!.toolInput).toEqual({ path: 'src' })
  })

  it('reads media parts', () => {
    expect(p.extractMediaBlocks(body).map(b => b.kind)).toEqual(['image'])
  })

  it('reads a bare Gemini body too, so a client that drops the envelope is still scanned', () => {
    expect(p.extractPrompts(JSON.stringify(turn))).toContain('list the files in src')
  })

  it('returns nothing for a body it cannot read', () => {
    expect(p.extractPrompts('not json')).toEqual([])
    expect(p.extractPrompts(JSON.stringify({ request: 'text' }))).toEqual([])
    expect(p.extractToolResults('null')).toEqual([])
  })
})

describe('CloudCodeParser: response envelope', () => {
  const call = { functionCall: { name: 'run_command', args: { command: 'ls' } } }
  const response = { response: { candidates: [{ content: { role: 'model', parts: [call] } }] }, traceId: 't1' }

  it('reads the tool calls of a buffered response', () => {
    expect(p.extractToolUses(JSON.stringify(response))).toEqual([{ toolName: 'run_command', args: { command: 'ls' } }])
  })

  it('reads the tool calls of a streamed response', () => {
    const sse = `data: ${JSON.stringify(response)}\r\n\r\n`
    expect(extractToolCallsFromSse(sse.replace(/\r\n/g, '\n'))).toEqual([{ toolName: 'run_command', args: { command: 'ls' } }])
  })

  it('removes a blocked call from a buffered response and keeps the envelope', () => {
    const out = JSON.parse(rewriteBlockedJsonResponse(JSON.stringify(response), new Set(['run_command'])))
    expect(out.traceId).toBe('t1')
    const parts = out.response.candidates[0].content.parts
    expect(parts.some((x: { functionCall?: unknown }) => x.functionCall)).toBe(false)
    expect(parts.some((x: { text?: unknown }) => typeof x.text === 'string')).toBe(true)
  })
})
