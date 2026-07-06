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
    'LLM_FW_EXTRA_TARGETS', 'LLM_FW_INTERCEPT_DOMAINS', 'LLM_FW_SUPPRESSIONS_ENABLED',
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

  it('defaults detection.suppressions to true and honours LLM_FW_SUPPRESSIONS_ENABLED', async () => {
    expect(DEFAULT_CONFIG.detection.suppressions).toBe(true)
    process.env.LLM_FW_SUPPRESSIONS_ENABLED = 'false'
    expect((await loadConfig()).detection.suppressions).toBe(false)
    process.env.LLM_FW_SUPPRESSIONS_ENABLED = 'true'
    expect((await loadConfig()).detection.suppressions).toBe(true)
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

  it('defaults proxy.interceptDomains to the registry suffixes, replaced by env', async () => {
    expect(DEFAULT_CONFIG.proxy.interceptDomains).toContain('openai.azure.com')
    process.env.LLM_FW_INTERCEPT_DOMAINS = 'llm.corp.internal'
    const cfg = await loadConfig()
    expect(cfg.proxy.interceptDomains).toEqual(['llm.corp.internal'])
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

  it('has no default surfaces override (absent ⇒ no per-surface behaviour change)', async () => {
    expect(DEFAULT_CONFIG.detection.surfaces).toBeUndefined()
    const cfg = await loadConfig()
    expect(cfg.detection.surfaces?.tool_result?.heuristicBlockThreshold).toBeUndefined()
  })

  it('LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD sets only the tool_result heuristic override', async () => {
    process.env.LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD = '30'
    const cfg = await loadConfig()
    expect(cfg.detection.surfaces?.tool_result?.heuristicBlockThreshold).toBe(30)
    // The global default and the document surface are untouched.
    expect(cfg.detection.heuristicBlockThreshold).toBe(DEFAULT_CONFIG.detection.heuristicBlockThreshold)
    expect(cfg.detection.surfaces?.document).toBeUndefined()
    delete process.env.LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD
  })

  it('ignores an unparsable LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD value', async () => {
    process.env.LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD = 'not-a-number'
    const cfg = await loadConfig()
    expect(cfg.detection.surfaces?.tool_result?.heuristicBlockThreshold).toBeUndefined()
    delete process.env.LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD
  })

  it('defaults detection.failMode to closed (matches the pre-C2 implicit deny-on-error)', async () => {
    expect(DEFAULT_CONFIG.detection.failMode).toBe('closed')
    const cfg = await loadConfig()
    expect(cfg.detection.failMode).toBe('closed')
  })

  it('LLM_FW_FAIL_MODE accepts only open/closed and ignores anything else', async () => {
    process.env.LLM_FW_FAIL_MODE = 'open'
    expect((await loadConfig()).detection.failMode).toBe('open')
    process.env.LLM_FW_FAIL_MODE = 'closed'
    expect((await loadConfig()).detection.failMode).toBe('closed')
    process.env.LLM_FW_FAIL_MODE = 'wide-open'
    expect((await loadConfig()).detection.failMode).toBe('closed')
    delete process.env.LLM_FW_FAIL_MODE
  })

  it('defaults detection.workerInference to false (Task C3, opt-in isolation)', async () => {
    expect(DEFAULT_CONFIG.detection.workerInference).toBe(false)
    const cfg = await loadConfig()
    expect(cfg.detection.workerInference).toBe(false)
  })

  it('LLM_FW_WORKER_INFERENCE toggles detection.workerInference', async () => {
    process.env.LLM_FW_WORKER_INFERENCE = 'true'
    expect((await loadConfig()).detection.workerInference).toBe(true)
    process.env.LLM_FW_WORKER_INFERENCE = 'false'
    expect((await loadConfig()).detection.workerInference).toBe(false)
    delete process.env.LLM_FW_WORKER_INFERENCE
  })
})
