import { Config, McpConfig } from '../../types.js'
import { DlpScanner } from '../dlp/scanner.js'
import { CommandScanner } from './commands.js'

export interface McpCheckResult {
  action: 'block' | 'pass'
  reason?: string
  // True when a policy matched and WOULD have blocked, but `auditOnly` mode
  // suppressed the block. The traffic still passes, but callers should surface
  // a 'warned' audit event rather than a silent 'passed' — otherwise audit
  // mode would log nothing, defeating its purpose.
  audit?: boolean
}

const EXECUTION_TOOLS = ['execute_command', 'bash', 'ctx_shell', 'powershell']

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings)
  return []
}

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
    // No recognized command key: scan EVERY string value (including nested
    // objects/arrays) so a destructive payload can't hide behind a benign
    // earlier field. Previously only the FIRST string value was returned,
    // which a caller could exploit by ordering a harmless string first.
    const strings = collectStrings(args)
    if (strings.length) return strings.join('\n')
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
        const reason = `Tool '${name}' is blocked by policy.`
        if (!this.config.auditOnly) {
          return { action: 'block', reason }
        }
        return { action: 'pass', audit: true, reason }
      }
    }
    return { action: 'pass' }
  }

  checkToolInvocation(toolName: string, args: unknown): McpCheckResult {
    if (!this.config.enabled) return { action: 'pass' }
    
    if (this.config.blockedTools.includes(toolName)) {
      const reason = `Invocation of tool '${toolName}' is blocked.`
      if (!this.config.auditOnly) {
        return { action: 'block', reason }
      }
      return { action: 'pass', audit: true, reason }
    }

    const guardrailsEnabled = this.config.guardrailsEnabled ?? true
    if (guardrailsEnabled && EXECUTION_TOOLS.includes(toolName)) {
      const command = extractCommandString(args)
      const categories = this.config.guardrailsCategories ?? { a: true, b: true, c: true, d: true }
      const scanResult = this.commandScanner.scan(command, categories)
      if (scanResult.isBlocked) {
        const reason = `Execution blocked by local security policy: ${scanResult.reason}`
        if (!this.config.auditOnly) {
          return { action: 'block', reason }
        }
        return { action: 'pass', audit: true, reason }
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
        const reason = `Sensitive data (${findings[0].type}) found in tool result (${toolUseId}).`
        if (this.dlp.config.mode === 'block') {
          if (!this.config.auditOnly) {
            return { action: 'block', reason }
          }
          return { action: 'pass', audit: true, reason }
        }
      }
    }
    return { action: 'pass' }
  }
}
