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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
  checkToolDefinitions(tools: any[]): McpCheckResult {
    if (!this.config.enabled) return { action: 'pass' }
    
    for (const tool of tools) {
      if (tool && typeof tool.name === 'string') {
        if (this.config.blockedTools.includes(tool.name)) {
          if (!this.config.auditOnly) {
            return { action: 'block', reason: `Tool '${tool.name}' is blocked by policy.` }
          }
        }
      }
    }
    return { action: 'pass' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkToolInvocation(toolName: string, _args: any): McpCheckResult {
    if (!this.config.enabled) return { action: 'pass' }
    
    if (this.config.blockedTools.includes(toolName)) {
      if (!this.config.auditOnly) {
        return { action: 'block', reason: `Invocation of tool '${toolName}' is blocked.` }
      }
    }
    // Future: check heuristic rules against JSON.stringify(args)
    return { action: 'pass' }
  }

  checkToolResult(toolName: string, result: string): McpCheckResult {
    if (!this.config.enabled) return { action: 'pass' }

    if (this.dlp) {
      const findings = this.dlp.scan(result)
      if (findings.length > 0) {
        // Since we cannot rewrite the tool_result payload easily here, 
        // we might just block if DLP is in block mode.
        if (this.dlp['config'].mode === 'block') { // Note: config is private in DlpScanner but we can access it or assume DLP handles its own emit
          return { action: 'block', reason: `Sensitive data (${findings[0]!.type}) found in tool result for '${toolName}'.` }
        }
      }
    }
    return { action: 'pass' }
  }
}
