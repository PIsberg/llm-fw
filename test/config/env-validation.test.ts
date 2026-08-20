import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig, ConfigError } from '../../src/config/config.js'

/**
 * Numeric environment overrides must refuse a value they cannot parse.
 *
 * `parseInt`/`parseFloat` return NaN for anything unparseable, and NaN poisons
 * quietly rather than loudly:
 *
 *   * `server.listen(NaN)` binds a RANDOM free port, so the firewall comes up
 *     somewhere nobody is pointing at.
 *   * a NaN detection threshold makes every `score >= threshold` comparison
 *     false, which turns a detection stage OFF with nothing in the log. On a
 *     prompt-injection firewall that is the worst possible failure: it still
 *     answers 200, it just stops blocking.
 *
 * Ten of the seventeen numeric overrides had no guard at all. The seven that
 * did silently ignored the bad value, which tells an operator their setting
 * took effect when it did not.
 */
const TOUCHED = [
  'LLM_FW_PROXY_PORT', 'LLM_FW_HTTPS_PORT', 'LLM_FW_DASHBOARD_PORT',
  'LLM_FW_MAX_BODY_BYTES', 'LLM_FW_EMBEDDING_BLOCK_THRESHOLD',
  'LLM_FW_EMBEDDING_WARN_THRESHOLD', 'LLM_FW_CLASSIFIER_THRESHOLD',
  'LLM_FW_DOS_MAX_RPM', 'LLM_FW_DOS_MAX_TOKENS_PER_SESSION',
  'LLM_FW_DOS_TOKEN_WINDOW_MS',
]

const saved: Record<string, string | undefined> = {}
beforeEach(() => { for (const k of TOUCHED) { saved[k] = process.env[k]; delete process.env[k] } })
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('numeric environment overrides fail fast', () => {
  it('refuses a port that is not a number rather than binding a random one', async () => {
    process.env.LLM_FW_PROXY_PORT = 'eight-thousand'
    await expect(loadConfig()).rejects.toThrow(ConfigError)
  })

  it('names the variable and the bad value in the message', async () => {
    process.env.LLM_FW_DASHBOARD_PORT = 'not-a-port'
    await expect(loadConfig()).rejects.toThrow(/LLM_FW_DASHBOARD_PORT="not-a-port"/)
  })

  it('refuses a detection threshold that would silently disable the stage', async () => {
    // The reason this one matters most: `similarity >= NaN` is false for every
    // similarity, so the embedding stage blocks nothing and says nothing.
    expect(0.95 >= Number.NaN).toBe(false)
    process.env.LLM_FW_EMBEDDING_BLOCK_THRESHOLD = 'high'
    await expect(loadConfig()).rejects.toThrow(ConfigError)
  })

  it('refuses a threshold outside 0..1, which no cosine can ever reach', async () => {
    process.env.LLM_FW_EMBEDDING_BLOCK_THRESHOLD = '86'
    await expect(loadConfig()).rejects.toThrow(/at most 1/)
  })

  it('refuses a port outside the legal range', async () => {
    process.env.LLM_FW_PROXY_PORT = '70000'
    await expect(loadConfig()).rejects.toThrow(/at most 65535/)
  })

  it('still accepts every valid value', async () => {
    process.env.LLM_FW_PROXY_PORT = '9090'
    process.env.LLM_FW_DASHBOARD_PORT = '0'          // 0 is legal: any free port
    process.env.LLM_FW_EMBEDDING_BLOCK_THRESHOLD = '0.9'
    process.env.LLM_FW_DOS_MAX_RPM = '120'
    const cfg = await loadConfig()
    expect(cfg.proxy.port).toBe(9090)
    expect(cfg.dashboard.port).toBe(0)
    expect(cfg.detection.embeddingBlockThreshold).toBe(0.9)
    expect(cfg.dos.maxRequestsPerMinute).toBe(120)
  })

  it('carries operational metadata so a caller can tell a typo from a bug', () => {
    const err = new ConfigError('LLM_FW_PROXY_PORT', 'abc', 'a whole number')
    expect(err.isOperational).toBe(true)
    expect(err.errorCode).toBe('CONFIG_INVALID')
    expect(err.variable).toBe('LLM_FW_PROXY_PORT')
  })
})
