import { describe, it, expect, afterEach } from 'vitest'
import { deepMerge, loadConfig, DEFAULT_CONFIG } from '../../src/config/config.js'

describe('deepMerge', () => {
  it('overrides primitive values from the source', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 9 })).toEqual({ a: 1, b: 9 })
  })

  it('merges nested objects recursively', () => {
    const out = deepMerge(
      { proxy: { port: 8080, httpsPort: 8443 } },
      { proxy: { httpsPort: 9000 } },
    )
    expect(out).toEqual({ proxy: { port: 8080, httpsPort: 9000 } })
  })

  it('replaces arrays wholesale rather than merging them', () => {
    const out = deepMerge({ targets: ['a', 'b', 'c'] }, { targets: ['x'] })
    expect(out).toEqual({ targets: ['x'] })
  })

  it('ignores undefined source values, keeping the target value', () => {
    const out = deepMerge({ a: 1, b: 2 }, { b: undefined } as Partial<{ a: number; b: number }>)
    expect(out).toEqual({ a: 1, b: 2 })
  })

  it('lets an explicit null in the source override the target', () => {
    const out = deepMerge({ a: 1 as number | null }, { a: null })
    expect(out).toEqual({ a: null })
  })

  it('does not mutate the target object', () => {
    const target = { proxy: { port: 8080 } }
    deepMerge(target, { proxy: { port: 1 } })
    expect(target.proxy.port).toBe(8080)
  })
})

describe('loadConfig env overrides', () => {
  const ENV_KEYS = [
    'LLM_FW_PROXY_PORT', 'LLM_FW_PROXY_MODE', 'LLM_FW_HTTPS_PORT',
    'LLM_FW_JUDGE_ENABLED', 'LLM_FW_DOS_MAX_RPM', 'LLM_FW_DLP_MODE',
    'LLM_FW_DASHBOARD_PORT', 'LLM_FW_PROXY_BIND', 'LLM_FW_DASHBOARD_BIND',
    'LLM_FW_EXTRA_TARGETS',
  ]
  afterEach(() => { for (const k of ENV_KEYS) delete process.env[k] })

  it('applies numeric env overrides', async () => {
    process.env.LLM_FW_PROXY_PORT = '9090'
    process.env.LLM_FW_HTTPS_PORT = '9443'
    process.env.LLM_FW_DASHBOARD_PORT = '7000'
    process.env.LLM_FW_DOS_MAX_RPM = '12'
    const cfg = await loadConfig()
    expect(cfg.proxy.port).toBe(9090)
    expect(cfg.proxy.httpsPort).toBe(9443)
    expect(cfg.dashboard.port).toBe(7000)
    expect(cfg.dos.maxRequestsPerMinute).toBe(12)
  })

  it('parses boolean env overrides from the string "true"', async () => {
    process.env.LLM_FW_JUDGE_ENABLED = 'true'
    expect((await loadConfig()).detection.judgeEnabled).toBe(true)
    process.env.LLM_FW_JUDGE_ENABLED = 'false'
    expect((await loadConfig()).detection.judgeEnabled).toBe(false)
  })

  it('applies string/enum env overrides', async () => {
    process.env.LLM_FW_PROXY_MODE = 'sinkhole'
    process.env.LLM_FW_DLP_MODE = 'block'
    const cfg = await loadConfig()
    expect(cfg.proxy.mode).toBe('sinkhole')
    expect(cfg.dlp.mode).toBe('block')
  })

  it('returns documented defaults for fields with no env/file override', async () => {
    const cfg = await loadConfig()
    expect(cfg.proxy.maxBodyBytes).toBe(DEFAULT_CONFIG.proxy.maxBodyBytes)
    expect(cfg.detection.chunkSize).toBe(DEFAULT_CONFIG.detection.chunkSize)
  })

  it('defaults the proxy and dashboard bind hosts to local-only', async () => {
    const cfg = await loadConfig()
    expect(cfg.proxy.bindHost).toBe('127.0.0.1')
    expect(cfg.dashboard.bindHost).toBe('127.0.0.1')
  })

  it('appends LLM_FW_EXTRA_TARGETS to the existing targets without replacing them', async () => {
    // Compare against a baseline load (the machine may have file configs that
    // already override targets) — extras must append, never replace.
    const base = await loadConfig()
    process.env.LLM_FW_EXTRA_TARGETS = ' my-vllm.internal , llm.lab.local ,'
    const cfg = await loadConfig()
    expect(cfg.targets).toContain('my-vllm.internal')
    expect(cfg.targets).toContain('llm.lab.local')
    for (const host of base.targets) expect(cfg.targets).toContain(host)
    // Appending is deduplicated.
    expect(new Set(cfg.targets).size).toBe(cfg.targets.length)
  })

  it('applies bind-host env overrides (standalone exposure)', async () => {
    process.env.LLM_FW_PROXY_BIND = '0.0.0.0'
    process.env.LLM_FW_DASHBOARD_BIND = '10.0.0.5'
    const cfg = await loadConfig()
    expect(cfg.proxy.bindHost).toBe('0.0.0.0')
    expect(cfg.dashboard.bindHost).toBe('10.0.0.5')
  })
})
