import { describe, it, expect } from 'vitest'
import { McpScanner } from '../../../src/detection/mcp/scanner.js'
import { DlpScanner } from '../../../src/detection/dlp/scanner.js'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'
import type { Config, DLPConfig } from '../../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a full Config with the mcp block overridden per-test. */
function makeConfig(mcp: Partial<Config['mcp']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    mcp: { ...DEFAULT_CONFIG.mcp, ...mcp },
  }
}

/** Convenience: scanner with mcp enabled and no auditOnly flag. */
function makeScanner(
  mcp: Partial<Config['mcp']> = {},
  dlp: DlpScanner | null = null,
): McpScanner {
  return new McpScanner(makeConfig(mcp), dlp)
}

// Real DLP scanner configured with the 'entropy' detector so we can trigger
// a GENERIC_SECRET finding via `password=<high-entropy-value>`.
// The value below is >20 chars and has entropy > 4.0 — reliably detected.
const HIGH_ENTROPY_SECRET = 'aZ9x7Qw2Lk8Pm3Vn6Rt1Yb4Hs0'
const DLP_BLOCK_CONFIG: DLPConfig = { enabled: true, mode: 'block', detectors: ['entropy'] }
const DLP_REDACT_CONFIG: DLPConfig = { enabled: true, mode: 'redact', detectors: ['entropy'] }

function makeDlpBlock(): DlpScanner {
  return new DlpScanner(DLP_BLOCK_CONFIG)
}

function makeDlpRedact(): DlpScanner {
  return new DlpScanner(DLP_REDACT_CONFIG)
}

// A string that the entropy detector will flag as GENERIC_SECRET.
const SECRET_PAYLOAD = `password=${HIGH_ENTROPY_SECRET}`

// ---------------------------------------------------------------------------
// checkToolDefinitions
// ---------------------------------------------------------------------------

describe('McpScanner.checkToolDefinitions — disabled', () => {
  it('returns pass when mcp.enabled is false, even with a blocked tool present', () => {
    const scanner = makeScanner({ enabled: false, blockedTools: ['execute_command'], auditOnly: false })
    const result = scanner.checkToolDefinitions([{ name: 'execute_command' }])
    expect(result.action).toBe('pass')
  })
})

describe('McpScanner.checkToolDefinitions — blocking', () => {
  it('blocks a tool whose name is in blockedTools', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
    const result = scanner.checkToolDefinitions([{ name: 'execute_command' }])
    expect(result.action).toBe('block')
    expect(result.reason).toBeDefined()
    expect(result.reason).toMatch(/execute_command/)
  })

  it('passes when no tool names match the blocklist', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
    const result = scanner.checkToolDefinitions([{ name: 'read_file' }, { name: 'list_dir' }])
    expect(result.action).toBe('pass')
    expect(result.reason).toBeUndefined()
  })

  it('blocks the first matching tool in a mixed list', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['delete_database'], auditOnly: false })
    const result = scanner.checkToolDefinitions([{ name: 'safe_tool' }, { name: 'delete_database' }])
    expect(result.action).toBe('block')
    expect(result.reason).toMatch(/delete_database/)
  })
})

describe('McpScanner.checkToolDefinitions — audit mode', () => {
  it('returns pass even for a blocked tool when auditOnly is true', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: true })
    const result = scanner.checkToolDefinitions([{ name: 'execute_command' }])
    expect(result.action).toBe('pass')
  })
})

describe('McpScanner.checkToolDefinitions — malformed entries', () => {
  it('does not throw on null entries in the tools array', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
    expect(() => scanner.checkToolDefinitions([null, { name: 'safe_tool' }])).not.toThrow()
  })

  it('does not throw on entries with missing name property', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
    expect(() => scanner.checkToolDefinitions([{}, { name: 'safe_tool' }])).not.toThrow()
  })

  it('does not throw on entries with non-string name', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
    expect(() => scanner.checkToolDefinitions([{ name: 42 }, { name: true }])).not.toThrow()
  })

  it('passes when all entries are malformed (no valid names to match)', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
    const result = scanner.checkToolDefinitions([null, {}, { name: 99 }])
    expect(result.action).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// checkToolInvocation
// ---------------------------------------------------------------------------

describe('McpScanner.checkToolInvocation — disabled', () => {
  it('returns pass when mcp.enabled is false', () => {
    const scanner = makeScanner({ enabled: false, blockedTools: ['execute_command'], auditOnly: false })
    expect(scanner.checkToolInvocation('execute_command', {}).action).toBe('pass')
  })
})

describe('McpScanner.checkToolInvocation — blocking', () => {
  it('blocks a tool name in blockedTools', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
    const result = scanner.checkToolInvocation('execute_command', { cmd: 'rm -rf /' })
    expect(result.action).toBe('block')
    expect(result.reason).toBeDefined()
    expect(result.reason).toMatch(/execute_command/)
  })

  it('passes a tool name NOT in blockedTools', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
    const result = scanner.checkToolInvocation('read_file', { path: '/etc/passwd' })
    expect(result.action).toBe('pass')
  })

  it('passes an empty args object for a non-blocked tool', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: false })
    expect(scanner.checkToolInvocation('list_dir', {}).action).toBe('pass')
  })
})

describe('McpScanner.checkToolInvocation — audit mode', () => {
  it('returns pass even for a blocked tool name when auditOnly is true', () => {
    const scanner = makeScanner({ enabled: true, blockedTools: ['execute_command'], auditOnly: true })
    const result = scanner.checkToolInvocation('execute_command', {})
    expect(result.action).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// checkToolResult
// ---------------------------------------------------------------------------

describe('McpScanner.checkToolResult — disabled', () => {
  it('returns pass when mcp.enabled is false, regardless of dlp', () => {
    const scanner = new McpScanner(makeConfig({ enabled: false }), makeDlpBlock())
    expect(scanner.checkToolResult('any_tool', SECRET_PAYLOAD).action).toBe('pass')
  })
})

describe('McpScanner.checkToolResult — no DLP collaborator', () => {
  it('returns pass when dlp is null', () => {
    const scanner = makeScanner({ enabled: true }, null)
    expect(scanner.checkToolResult('read_file', SECRET_PAYLOAD).action).toBe('pass')
  })
})

describe('McpScanner.checkToolResult — DLP in block mode with findings', () => {
  it('blocks when dlp.scan() returns findings and dlp.config.mode === "block"', () => {
    // Real DlpScanner with entropy detector — detects GENERIC_SECRET in SECRET_PAYLOAD.
    const dlp = makeDlpBlock()
    const scanner = new McpScanner(makeConfig({ enabled: true }), dlp)
    const result = scanner.checkToolResult('read_file', SECRET_PAYLOAD)
    expect(result.action).toBe('block')
    expect(result.reason).toBeDefined()
    // Reason should mention the finding type and the tool name.
    expect(result.reason).toMatch(/GENERIC_SECRET/)
    expect(result.reason).toMatch(/read_file/)
  })

  it('reason mentions the first finding type when multiple detectors fire', () => {
    // AWS key is detected by the 'aws' detector (high-confidence regex).
    const dlp = new DlpScanner({ enabled: true, mode: 'block', detectors: ['aws'] })
    const scanner = new McpScanner(makeConfig({ enabled: true }), dlp)
    const awsKey = 'AKIAIOSFODNN7EXAMPLE'
    const result = scanner.checkToolResult('get_secret', awsKey)
    expect(result.action).toBe('block')
    expect(result.reason).toMatch(/AWS_ACCESS_KEY/)
    expect(result.reason).toMatch(/get_secret/)
  })
})

describe('McpScanner.checkToolResult — DLP in non-block mode with findings', () => {
  it('returns pass when dlp.scan() has findings but mode is "redact"', () => {
    const dlp = makeDlpRedact()
    const scanner = new McpScanner(makeConfig({ enabled: true }), dlp)
    const result = scanner.checkToolResult('read_file', SECRET_PAYLOAD)
    // Findings exist but mode is 'redact', not 'block' → pass
    expect(result.action).toBe('pass')
  })

  it('returns pass when dlp.scan() has findings but mode is "audit"', () => {
    const dlp = new DlpScanner({ enabled: true, mode: 'audit', detectors: ['entropy'] })
    const scanner = new McpScanner(makeConfig({ enabled: true }), dlp)
    const result = scanner.checkToolResult('read_file', SECRET_PAYLOAD)
    expect(result.action).toBe('pass')
  })
})

describe('McpScanner.checkToolResult — DLP with no findings', () => {
  it('returns pass when dlp.scan() returns no findings, even in block mode', () => {
    const dlp = makeDlpBlock()
    const scanner = new McpScanner(makeConfig({ enabled: true }), dlp)
    // Plain text — no secrets, no keywords → no findings.
    const result = scanner.checkToolResult('read_file', 'hello world, nothing to see here')
    expect(result.action).toBe('pass')
  })
})
