import { describe, it, expect } from 'vitest'
import { isStandalone, applyStandaloneOverrides, lanIPv4 } from '../../src/cli/start.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

function freshConfig(): Config {
  return structuredClone(DEFAULT_CONFIG)
}

describe('isStandalone', () => {
  it('recognises both --stand-alone and --standalone spellings', () => {
    expect(isStandalone(['--stand-alone'])).toBe(true)
    expect(isStandalone(['--standalone'])).toBe(true)
    expect(isStandalone(['start', '--stand-alone'])).toBe(true)
  })

  it('is false without the flag', () => {
    expect(isStandalone([])).toBe(false)
    expect(isStandalone(['--proxy-only'])).toBe(false)
  })
})

describe('applyStandaloneOverrides', () => {
  it('binds proxy and dashboard to all interfaces and forces proxy mode', () => {
    const cfg = freshConfig()
    cfg.proxy.mode = 'sinkhole'
    applyStandaloneOverrides(cfg, {})
    expect(cfg.proxy.mode).toBe('proxy')
    expect(cfg.proxy.bindHost).toBe('0.0.0.0')
    expect(cfg.dashboard.bindHost).toBe('0.0.0.0')
  })

  it('preserves bind hosts already set from env (loadConfig precedence)', () => {
    // Models the real flow: loadConfig() has already applied LLM_FW_*_BIND, so
    // standalone must NOT clobber those values back to 0.0.0.0.
    const cfg = freshConfig()
    cfg.proxy.bindHost = '192.168.1.10'
    cfg.dashboard.bindHost = '127.0.0.1'
    applyStandaloneOverrides(cfg, {
      LLM_FW_PROXY_BIND: '192.168.1.10',
      LLM_FW_DASHBOARD_BIND: '127.0.0.1',
    })
    expect(cfg.proxy.bindHost).toBe('192.168.1.10')
    expect(cfg.dashboard.bindHost).toBe('127.0.0.1')
  })
})

describe('lanIPv4', () => {
  it('returns a string (an IPv4 address or the documented placeholder)', () => {
    const ip = lanIPv4()
    expect(typeof ip).toBe('string')
    expect(ip.length).toBeGreaterThan(0)
    // Either a dotted-quad LAN address or the fallback hint.
    expect(/^\d+\.\d+\.\d+\.\d+$/.test(ip) || ip === '<this-server-ip>').toBe(true)
  })
})
