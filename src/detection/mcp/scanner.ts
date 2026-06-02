import { Config, McpConfig } from '../../types.js'
import { DlpScanner } from '../dlp/scanner.js'
import { CommandScanner } from './commands.js'

export interface McpCheckResult {
  action: 'block' | 'pass'
  reason?: string
}

const EXECUTION_TOOLS = ['execute_command', 'bash', 'ctx_shell', 'powershell']

export function extractCommandString(args: unknown): string {
  if (typeof args === 'string') {
    return args
  }
  if (args && typeof args === 'object') {
    const obj = args as Record<string, unknown>
    const commandKeys = ['command', 'cmd', 'code', 'script', 'arguments', 'args']
    for (const key of commandKeys) {
      if (typeof obj[key] === 'string') {
        return obj[key] as string
      }
    }
    for (const val of Object.values(obj)) {
      if (typeof val === 'string') {
        return val
      }
    }
    return JSON.stringify(args)
  }
  return ''
}

export class McpScanner {
  private config: McpConfig
  private dlp: DlpScanner | null
  private commandScanner = new CommandScanner()

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

  checkToolInvocation(toolName: string, args: unknown): McpCheckResult {
    if (!this.config.enabled) return { action: 'pass' }
    
    if (this.config.blockedTools.includes(toolName)) {
      if (!this.config.auditOnly) {
        return { action: 'block', reason: `Invocation of tool '${toolName}' is blocked.` }
      }
    }

    const guardrailsEnabled = this.config.guardrailsEnabled ?? true
    if (guardrailsEnabled && EXECUTION_TOOLS.includes(toolName)) {
      const command = extractCommandString(args)
      const categories = this.config.guardrailsCategories ?? { a: true, b: true, c: true, d: true }
      const scanResult = this.commandScanner.scan(command, categories)
      if (scanResult.isBlocked) {
        if (!this.config.auditOnly) {
          return {
            action: 'block',
            reason: `Execution blocked by local security policy: ${scanResult.reason}`,
          }
        }
      }
    }

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
