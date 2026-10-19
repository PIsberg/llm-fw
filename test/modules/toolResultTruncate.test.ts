import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import { ToolResultTruncateModule, truncateMiddle } from '../../src/modules/builtin/toolResultTruncate.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

describe('truncateMiddle', () => {
  it('keeps the first and last lines and says how many were dropped', () => {
    const out = truncateMiddle(lines(1000), { headLines: 200, tailLines: 100, maxChars: 0 })
    const kept = out.split('\n')
    expect(kept).toHaveLength(301)
    expect(kept[0]).toBe('line 1')
    expect(kept[199]).toBe('line 200')
    expect(kept[200]).toBe('[llm-fw: 700 lines elided]')
    expect(kept[201]).toBe('line 901')
    expect(kept[300]).toBe('line 1000')
  })

  it('leaves output within the limits untouched', () => {
    const text = lines(300)
    expect(truncateMiddle(text, { headLines: 200, tailLines: 100, maxChars: 100_000 })).toBe(text)
  })

  it('cuts a single huge line by characters, two thirds from the head', () => {
    const text = 'a'.repeat(6000) + 'b'.repeat(6000)
    const out = truncateMiddle(text, { headLines: 200, tailLines: 100, maxChars: 3000 })
    expect(out).toBe('a'.repeat(2000) + '\n[llm-fw: 9000 characters elided]\n' + 'b'.repeat(1000))
  })

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(3000)
    const out = truncateMiddle(text, { headLines: 0, tailLines: 0, maxChars: 1001 })
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('treats a zero limit as off', () => {
    const text = lines(5000)
    expect(truncateMiddle(text, { headLines: 0, tailLines: 0, maxChars: 0 })).toBe(text)
  })
})

describe('ToolResultTruncateModule', () => {
  it('truncates tool output only, with live limits', () => {
    const cfg = { enabled: true, headLines: 10, tailLines: 5, maxChars: 0 }
    const mod = new ToolResultTruncateModule(cfg)
    const body = JSON.stringify({ messages: [
      { role: 'tool', tool_call_id: 'c', content: lines(100) },
      { role: 'user', content: lines(100) },
    ] })
    const parsed = JSON.parse(mod.transformRequest(body, ctx).body)
    expect(parsed.messages[0].content.split('\n')).toHaveLength(16)
    expect(parsed.messages[1].content).toBe(lines(100))
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)

    cfg.headLines = 0
    cfg.tailLines = 0
    expect(mod.transformRequest(body, ctx).modified).toBe(false)
  })
})

// The live round on 2026-10-17: after a file read came back with lines
// elided, Claude Code read the elided range back, and sessions took 24% more
// turns. File reads are therefore left whole; command output is still cut.
describe('ToolResultTruncateModule skipTools', () => {
  const long = lines(100)
  const isCut = (text: string) => text.includes('lines elided]')
  const truncator = (skipTools = ['Read', 'read_file']) =>
    new ToolResultTruncateModule({ enabled: true, headLines: 10, tailLines: 5, maxChars: 0, skipTools, skipCommands: DEFAULT_CONFIG.modules!.toolResultTruncate!.skipCommands })
  const send = (mod: ToolResultTruncateModule, payload: unknown) =>
    JSON.parse(mod.transformRequest(JSON.stringify(payload), ctx).body)
  const sse = (...events: unknown[]) => ({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Buffer.from(events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')),
  })

  it('leaves a file read whole and cuts command output, in an Anthropic history', () => {
    const out = send(truncator(), { messages: [
      { role: 'user', content: 'look' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'npm test' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_r', content: long },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: long },
      ] },
    ] })
    expect(out.messages[2].content[0].content).toBe(long)
    expect(isCut(out.messages[2].content[1].content)).toBe(true)
  })

  it('reads the tool name from OpenAI chat tool_calls and Responses API function_call items', () => {
    const chat = send(truncator(), { messages: [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_r', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'call_s', type: 'function', function: { name: 'shell', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_r', content: long },
      { role: 'tool', tool_call_id: 'call_s', content: long },
    ] })
    expect(chat.messages[1].content).toBe(long)
    expect(isCut(chat.messages[2].content)).toBe(true)

    const responses = send(truncator(), { input: [
      { type: 'function_call', call_id: 'call_r', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_r', output: long },
      { type: 'function_call', call_id: 'call_s', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_s', output: long },
    ] })
    expect(responses.input[1].output).toBe(long)
    expect(isCut(responses.input[3].output)).toBe(true)
  })

  it('matches an MCP tool whose name ends in "__" and the listed name, and nothing looser', () => {
    const named = (name: string) => send(truncator(), { messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: long }] },
    ] }).messages[1].content[0].content
    expect(named('mcp__filesystem__read_file')).toBe(long)
    expect(isCut(named('mcp__filesystem__preread_file'))).toBe(true)
    expect(isCut(named('ReadAll'))).toBe(true)
  })

  // Claude Code through the proxy keeps a server-side thread: the request
  // carries the tool results and not the assistant turn that named the tools.
  it('learns tool names from a streamed Anthropic response for a thread continuation', () => {
    const mod = truncator()
    const continuation = { thread: { type: 'continue', previous_message_id: 'msg_1' }, messages: [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_r', content: long },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: long },
      ] },
    ] }
    // No response seen yet: the tool is unknown and the result is cut as before.
    expect(isCut(send(mod, continuation).messages[0].content[0].content)).toBe(true)

    mod.observeResponse('{}', ctx, sse(
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_r', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ))
    const out = send(mod, continuation)
    expect(out.messages[0].content[0].content).toBe(long)
    expect(isCut(out.messages[0].content[1].content)).toBe(true)
  })

  it('learns tool names from a Responses API response, gzipped JSON or streamed', () => {
    const mod = truncator()
    mod.observeResponse('{}', ctx, {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify({ id: 'resp_1', output: [{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' }] })),
    })
    mod.observeResponse('{}', ctx, sse(
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: '' } },
    ))
    const out = send(mod, { previous_response_id: 'resp_1', input: [
      { type: 'function_call_output', call_id: 'call_1', output: long },
      { type: 'function_call_output', call_id: 'call_2', output: long },
      { type: 'function_call_output', call_id: 'call_3', output: long },
    ] })
    expect(out.input[0].output).toBe(long)
    expect(out.input[1].output).toBe(long)
    expect(isCut(out.input[2].output)).toBe(true)
  })

  it('takes skipTools live', () => {
    const cfg = { enabled: true, headLines: 10, tailLines: 5, maxChars: 0, skipTools: ['Read'] }
    const mod = new ToolResultTruncateModule(cfg)
    const payload = { messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: long }] },
    ] }
    expect(send(mod, payload).messages[1].content[0].content).toBe(long)
    cfg.skipTools = []
    expect(isCut(send(mod, payload).messages[1].content[0].content)).toBe(true)
  })

  // #363: after skipTools, about half of what the truncator still cut on 30
  // days of one developer's transcripts was file reads through a shell tool
  // (cat, sed -n, awk in Bash: 19.4% of the removed tokens, against 9.5% for
  // all other shell output). Those are recognised by the command now.
  it('leaves a file read through a shell tool whole, by its command', () => {
    const shell = (id: string, name: string, command: unknown) => ({ type: 'tool_use', id, name, input: { command } })
    const out = send(truncator(), { messages: [
      { role: 'assistant', content: [
        shell('t_cat', 'Bash', 'cat src/a.ts'),
        shell('t_cd', 'Bash', 'cd /repo && sed -n 1,400p src/a.ts'),
        shell('t_codex', 'shell', ['bash', '-lc', 'head -100 CHANGELOG.md']),
        shell('t_test', 'Bash', 'npm test 2>&1'),
        shell('t_log', 'Bash', 'git log --oneline -200'),
        shell('t_odd', 'Bash', 42),
      ] },
      { role: 'user', content: ['t_cat', 't_cd', 't_codex', 't_test', 't_log', 't_odd'].map(id => ({ type: 'tool_result', tool_use_id: id, content: long })) },
    ] })
    const results = out.messages[1].content.map((r: { content: string }) => isCut(r.content))
    expect(results).toEqual([false, false, false, true, true, true])
  })

  it('learns the command from a streamed response for a thread continuation', () => {
    const mod = truncator()
    mod.observeResponse('{}', ctx, sse(
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_cat', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"cat ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'big.log"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_test', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ))
    const out = send(mod, { thread: { type: 'continue', previous_message_id: 'msg_1' }, messages: [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_cat', content: long },
        { type: 'tool_result', tool_use_id: 'toolu_test', content: long },
      ] },
    ] })
    expect(out.messages[0].content[0].content).toBe(long)
    expect(isCut(out.messages[0].content[1].content)).toBe(true)
  })

  it('takes skipCommands live', () => {
    const cfg = { enabled: true, headLines: 10, tailLines: 5, maxChars: 0, skipTools: [], skipCommands: ['cat'] }
    const mod = new ToolResultTruncateModule(cfg)
    const payload = { messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'cat a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: long }] },
    ] }
    expect(send(mod, payload).messages[1].content[0].content).toBe(long)
    cfg.skipCommands = []
    expect(isCut(send(mod, payload).messages[1].content[0].content)).toBe(true)
  })

  it('skips the file-read tools of Claude Code, the MCP filesystem server and Gemini CLI by default', () => {
    const mod = new ToolResultTruncateModule({ ...structuredClone(DEFAULT_CONFIG.modules!.toolResultTruncate!), enabled: true })
    const big = lines(1000)
    for (const name of ['Read', 'read_file', 'mcp__filesystem__read_text_file', 'Bash']) {
      const out = send(mod, { messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: big }] },
      ] }).messages[1].content[0].content
      expect(isCut(out), name).toBe(name === 'Bash')
    }
  })
})
