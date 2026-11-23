import type { PayloadParser } from '../../types.js'
import type { McpScanner } from './scanner.js'

/** An MCP event, without where it was seen: the caller adds target, method, path and tenant. */
export interface McpRequestEvent {
  stage: 'mcp-filter'
  score: number
  similarity: number
  payload_preview: string
  payload_full: string
  action: 'blocked' | 'warned' | 'passed'
  kind: 'mcp'
  mcpTool?: string
}

/**
 * The MCP request checks: tool definitions and returned tool results (#866).
 * They lived inline in the proxy, so the gateway ran neither; both call this
 * now. `refusal` is the reason to refuse the request, or null; `events` are
 * what to record, a refusal's own included, in order. A result whose call is
 * not in the request (a thread continuation) is named by `nameOf`, the call
 * learned from an earlier response.
 */
export function checkMcpRequest(
  parser: PayloadParser,
  body: string,
  mcp: McpScanner,
  nameOf: (toolUseId: string) => string | undefined,
): { refusal: string | null; events: McpRequestEvent[] } {
  const events: McpRequestEvent[] = []
  if (!mcp.isEnabled()) return { refusal: null, events }

  const tools = parser.extractTools(body)
  if (tools.length > 0) {
    const full = JSON.stringify(tools)
    const def = mcp.checkToolDefinitions(tools)
    if (def.action === 'block') {
      events.push({ stage: 'mcp-filter', score: 100, similarity: 0, payload_preview: 'Blocked tool definition', payload_full: full, action: 'blocked', kind: 'mcp' })
      return { refusal: def.reason ?? 'blocked tool definition', events }
    }
    events.push(def.audit
      ? { stage: 'mcp-filter', score: 50, similarity: 0, payload_preview: `Audit: would block tool definition (${def.reason ?? ''})`, payload_full: full, action: 'warned', kind: 'mcp' }
      : { stage: 'mcp-filter', score: 0, similarity: 0, payload_preview: `Exposed ${tools.length} tools to LLM`, payload_full: full, action: 'passed', kind: 'mcp' })
  }

  for (const tr of parser.extractToolResults(body)) {
    const toolName = tr.toolName ?? nameOf(tr.toolUseId)
    const named = toolName ? { mcpTool: toolName } : {}
    const res = mcp.checkToolResult(tr.toolUseId, tr.result)
    if (res.action === 'block') {
      events.push({ stage: 'mcp-filter', score: 100, similarity: 0, payload_preview: `Blocked tool result (id ${tr.toolUseId})`, payload_full: tr.result, action: 'blocked', kind: 'mcp', ...named })
      return { refusal: res.reason ?? 'blocked tool result', events }
    }
    events.push(res.audit
      ? { stage: 'mcp-filter', score: 50, similarity: 0, payload_preview: `Audit: would block tool result (id ${tr.toolUseId}) — ${res.reason ?? ''}`, payload_full: tr.result, action: 'warned', kind: 'mcp', ...named }
      : {
        stage: 'mcp-filter', score: 0, similarity: 0,
        // The tool it answers, so the MCP tab can group calls and results (#591).
        payload_preview: toolName ? `Tool result returned from ${toolName} (id ${tr.toolUseId})` : `Tool result returned (id ${tr.toolUseId})`,
        payload_full: tr.result, action: 'passed', kind: 'mcp', ...named,
      })
  }
  return { refusal: null, events }
}
