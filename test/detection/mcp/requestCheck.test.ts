import { describe, it, expect } from 'vitest'
import { checkMcpRequest } from '../../../src/detection/mcp/requestCheck.js'
import { McpScanner } from '../../../src/detection/mcp/scanner.js'
import { DlpScanner } from '../../../src/detection/dlp/scanner.js'
import { getParser } from '../../../src/detection/parsers.js'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'

// #866: the MCP request checks (tool definitions, tool results) lived inline
// in the proxy, so the gateway ran neither. One function now decides for both.
const parser = getParser('/v1/messages')!
const body = (tools: unknown[], content: unknown = 'hello') => JSON.stringify({ model: 'm', max_tokens: 5, tools, messages: [{ role: 'user', content }] })

describe('checkMcpRequest', () => {
  const mcp = new McpScanner(DEFAULT_CONFIG, null)

  it('refuses a blocked tool definition and records the event', () => {
    const r = checkMcpRequest(parser, body([{ name: 'execute_command', input_schema: {} }]), mcp, () => undefined)
    expect(r.refusal).toMatch(/execute_command/)
    expect(r.events).toEqual([expect.objectContaining({ stage: 'mcp-filter', action: 'blocked', kind: 'mcp' })])
  })

  it('records exposed tools and passes', () => {
    const r = checkMcpRequest(parser, body([{ name: 'get_weather', input_schema: {} }]), mcp, () => undefined)
    expect(r.refusal).toBeNull()
    expect(r.events).toEqual([expect.objectContaining({ action: 'passed', payload_preview: 'Exposed 1 tools to LLM' })])
  })

  it('names the tool a result answers, from the caller when the request does not', () => {
    const content = [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'done' }]
    const r = checkMcpRequest(parser, body([], content), mcp, id => (id === 'toolu_9' ? 'Bash' : undefined))
    expect(r.events).toEqual([expect.objectContaining({ action: 'passed', mcpTool: 'Bash' })])
  })

  it('refuses a tool result carrying a secret when DLP blocks', () => {
    const dlp = new DlpScanner({ ...DEFAULT_CONFIG.dlp, enabled: true, mode: 'block' })
    const scanner = new McpScanner(DEFAULT_CONFIG, dlp)
    const content = [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'key AKIAABCDEFGHIJKLMNOP' }]
    const r = checkMcpRequest(parser, body([], content), scanner, () => undefined)
    expect(r.refusal).toMatch(/toolu_1/)
  })

  it('does nothing when MCP inspection is off', () => {
    const off = new McpScanner({ ...DEFAULT_CONFIG, mcp: { ...DEFAULT_CONFIG.mcp, enabled: false } }, null)
    expect(checkMcpRequest(parser, body([{ name: 'execute_command' }]), off, () => undefined)).toEqual({ refusal: null, events: [] })
  })
})
