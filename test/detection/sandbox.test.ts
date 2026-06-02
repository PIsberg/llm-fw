import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SandboxDetector } from '../../src/detection/sandbox.js'
import fs from 'node:fs'

vi.mock('node:fs')

describe('SandboxDetector', () => {
  let detector: SandboxDetector
  const originalEnv = process.env

  beforeEach(() => {
    detector = new SandboxDetector()
    process.env = { ...originalEnv }
    delete process.env.LLMFW_SANDBOX
    delete process.env.KUBERNETES_SERVICE_HOST
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readFileSync).mockReturnValue('')
  })

  afterEach(() => {
    process.env = originalEnv
    vi.clearAllMocks()
  })

  it('detects explicit override', () => {
    process.env.LLMFW_SANDBOX = 'true'
    const result = detector.detect(undefined, undefined)
    expect(result.sandboxed).toBe(true)
    expect(result.confidence).toBe(1.0)
    expect(result.signals).toContain('env-override=true')
  })

  it('detects explicit false override', () => {
    process.env.LLMFW_SANDBOX = 'false'
    const result = detector.detect(undefined, undefined)
    expect(result.sandboxed).toBe(false)
    expect(result.confidence).toBe(1.0)
  })

  it('detects claude-code UA + docker IP', () => {
    const result = detector.detect('claude-cli/1.0.0', '172.17.0.2')
    expect(result.client).toBe('claude-code')
    expect(result.sandboxed).toBe(true) // 0.5 (UA) + 0.3 (IP) = 0.8 >= 0.75
    expect(result.confidence).toBe(0.8)
    expect(result.signals).toContain('ua-claude')
    expect(result.signals).toContain('ip-docker-bridge')
  })

  it('detects antigravity UA + loopback IP', () => {
    const result = detector.detect('antigravity/0.1', '127.0.0.1')
    expect(result.client).toBe('antigravity')
    // 0.6 (UA) + 0 (IP loopback does not add confidence directly) = 0.6 < 0.75
    // But wait, Antigravity built-in sandbox might run locally. 
    // Is 0.6 enough? The current logic is >= 0.75.
    expect(result.sandboxed).toBe(false)
    expect(result.confidence).toBe(0.6)
    expect(result.signals).toContain('ua-antigravity')
    expect(result.signals).toContain('ip-loopback')
  })

  it('reaches confidence 1.0 with multiple signals', () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/.dockerenv')
    const result = detector.detect('antigravity', '10.0.0.5')
    // 0.6 (UA) + 0.3 (IP) + 0.5 (dockerenv) = 1.4 -> capped at 1.0
    expect(result.sandboxed).toBe(true)
    expect(result.confidence).toBe(1.0)
    expect(result.signals).toEqual(['ua-antigravity', 'ip-private-10', 'env-dockerenv'])
  })

  it('handles IPv6-mapped IPv4 addresses', () => {
    const result = detector.detect('claude code', '::ffff:172.18.0.5')
    expect(result.sandboxed).toBe(true) // 0.5 (UA) + 0.3 (IP) = 0.8
    expect(result.signals).toContain('ip-docker-bridge')
  })
})
