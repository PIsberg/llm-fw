import { Config, McpConfig } from '../../types.js'
import { DlpScanner } from '../dlp/scanner.js'

export interface McpCheckResult {
  action: 'block' | 'pass'
  reason?: string
}

export class McpScanner {
  private config: McpConfig
  private dlp: DlpScanner | null

  constructor(config: Config, dlp: DlpScanner | null) {
    this.config = config.mcp
    this.dlp = dlp
  }

  checkToolDefinitions(tools: unknown[]): McpCheckResult {
    if (!this.config.enabled) return { action: 'pass' }

    for (const tool of tools) {
      const name = (tool as { name?: unknown } | null)?.name
      if (typeof name === 'string' && this.config.blockedTools.includes(name)) {
        if (!this.config.auditOnly) {
          return { action: 'block', reason: `Tool '${name}' is blocked by policy.` }
        }
      }
    }
    return { action: 'pass' }
  }

  checkToolInvocation(toolName: string, _args: unknown): McpCheckResult {
    if (!this.config.enabled) return { action: 'pass' }
    
    if (this.config.blockedTools.includes(toolName)) {
      if (!this.config.auditOnly) {
        return { action: 'block', reason: `Invocation of tool '${toolName}' is blocked.` }
      }
    }
    // Future: check heuristic rules against JSON.stringify(args)
    return { action: 'pass' }
  }

  checkToolResult(toolUseId: string, result: string): McpCheckResult {
    if (!this.config.enabled) return { action: 'pass' }

    if (this.dlp) {
      const findings = this.dlp.scan(result)
      if (findings.length > 0) {
        // We cannot redact the tool_result payload at this layer, so when DLP is
        // in block mode we drop the whole request to prevent exfiltration.
        if (this.dlp.config.mode === 'block') {
          return { action: 'block', reason: `Sensitive data (${findings[0].type}) found in tool result (${toolUseId}).` }
        }
      }
    }
    return { action: 'pass' }
  }
}
