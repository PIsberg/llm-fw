import { describe, it, expect } from 'vitest'
import { AnthropicParser } from '../../src/detection/parsers.js'

// Text a third party wrote reaches the model through more block types than
// tool_result. Each of these used to go upstream without being scanned.
describe('Anthropic: third-party text the model reads is scanned as tool output', () => {
  const parser = new AnthropicParser()
  const results = (messages: unknown[]) => parser.extractToolResults(JSON.stringify({ model: 'm', messages }))
  const text = (messages: unknown[]) => results(messages).map(r => r.result).join('\n')

  it('a search_result block in a user message', () => {
    expect(text([{ role: 'user', content: [
      { type: 'text', text: 'Answer from these results.' },
      { type: 'search_result', source: 'https://docs.example/a', title: 'Result A', content: [{ type: 'text', text: 'PAYLOAD-SEARCH' }] },
    ] }])).toContain('PAYLOAD-SEARCH')
  })

  // Server tools run at the provider, and the client resends their results in
  // the assistant turn of every later request.
  it('a web_fetch result resent in an assistant turn, named after its tool', () => {
    const r = results([
      { role: 'user', content: 'Summarise https://evil.example' },
      { role: 'assistant', content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url: 'https://evil.example' } },
        { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: {
          type: 'web_fetch_result', url: 'https://evil.example', retrieved_at: '2026-10-24T10:00:00Z',
          content: { type: 'document', title: 'Evil', source: { type: 'text', media_type: 'text/plain', data: 'PAYLOAD-FETCH' } },
        } },
        { type: 'text', text: 'Here is the summary.' },
      ] },
      { role: 'user', content: 'Thanks' },
    ])
    const fetched = r.find(x => x.result.includes('PAYLOAD-FETCH'))
    expect(fetched).toBeDefined()
    expect(fetched?.toolName).toBe('web_fetch')
  })

  it('an MCP connector result', () => {
    expect(text([
      { role: 'user', content: 'Check the ticket' },
      { role: 'assistant', content: [
        { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'get_ticket', server_name: 'tracker', input: {} },
        { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_1', is_error: false, content: [{ type: 'text', text: 'PAYLOAD-MCP' }] },
      ] },
      { role: 'user', content: 'go on' },
    ])).toContain('PAYLOAD-MCP')
  })

  it('code execution output', () => {
    expect(text([
      { role: 'user', content: 'Run it' },
      { role: 'assistant', content: [
        { type: 'server_tool_use', id: 'srvtoolu_2', name: 'bash_code_execution', input: { command: 'cat notes.txt' } },
        { type: 'bash_code_execution_tool_result', tool_use_id: 'srvtoolu_2', content: {
          type: 'bash_code_execution_result', stdout: 'PAYLOAD-STDOUT', stderr: 'PAYLOAD-STDERR', return_code: 0, content: [],
        } },
      ] },
      { role: 'user', content: 'and?' },
    ])).toMatch(/PAYLOAD-STDOUT[\s\S]*PAYLOAD-STDERR/)
  })

  it('a web search result by its title, not its encrypted body', () => {
    // encrypted_content is opaque to llm-fw and would only feed noise to the
    // entropy and decoding checks.
    const t = text([
      { role: 'user', content: 'Search it' },
      { role: 'assistant', content: [
        { type: 'server_tool_use', id: 'srvtoolu_3', name: 'web_search', input: { query: 'q' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_3', content: [
          { type: 'web_search_result', url: 'https://x.example', title: 'PAYLOAD-TITLE', encrypted_content: 'EqgfCioIARgBIiQ3YTAwMjY1Mi1jZjY2', page_age: '1 day' },
        ] },
      ] },
      { role: 'user', content: 'ok' },
    ])
    expect(t).toContain('PAYLOAD-TITLE')
    expect(t).not.toContain('EqgfCioIARgB')
  })

  it('leaves the assistant\'s own text and tool calls alone', () => {
    expect(text([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ASSISTANT-PROSE' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    ])).not.toContain('ASSISTANT-PROSE')
  })
})
