import { describe, it, expect } from 'vitest'
import { QuotaManager } from '../../../src/detection/dos/quota.js'
import { DosConfig } from '../../../src/types.js'

function makeConfig(overrides: Partial<DosConfig> = {}): DosConfig {
  return {
    enabled: true,
    maxRequestsPerMinute: 3,
    maxTokensPerSession: 100,
    loopDetectionEnabled: true,
    ...overrides,
  }
}

describe('QuotaManager — live config', () => {
  it('reads limits from the live config object (dashboard tuning takes effect immediately)', () => {
    const cfg = makeConfig({ maxRequestsPerMinute: 2, maxTokensPerSession: 100 })
    const q = new QuotaManager(cfg)
    const t = 1_000_000
    expect(q.checkRpm(t).allowed).toBe(true)
    expect(q.checkRpm(t + 1).allowed).toBe(true)
    expect(q.checkRpm(t + 2).allowed).toBe(false) // limit 2 reached
    // Raise the limit on the shared config — no reconstruction.
    cfg.maxRequestsPerMinute = 5
    expect(q.checkRpm(t + 3).allowed).toBe(true)

    q.addTokens(150, t)
    expect(q.sessionExceeded(t)).toBe(true)
    cfg.maxTokensPerSession = 1000
    expect(q.sessionExceeded(t)).toBe(false)
  })
})

describe('QuotaManager — sliding-window RPM limiter', () => {
  it('allows requests under the limit', () => {
    const q = new QuotaManager(makeConfig({ maxRequestsPerMinute: 3 }))
    const t = 1_000_000
    expect(q.checkRpm(t).allowed).toBe(true)
    expect(q.checkRpm(t + 1).allowed).toBe(true)
    expect(q.checkRpm(t + 2).allowed).toBe(true)
    expect(q.requestsInWindow(t + 2)).toBe(3)
  })

  it('blocks the request that would exceed the limit and reports retryAfter', () => {
    const q = new QuotaManager(makeConfig({ maxRequestsPerMinute: 3 }))
    const t = 1_000_000
    q.checkRpm(t)
    q.checkRpm(t + 1000)
    q.checkRpm(t + 2000)
    const res = q.checkRpm(t + 3000)
    expect(res.allowed).toBe(false)
    expect(res.retryAfterSec).toBeGreaterThan(0)
    // Oldest in-window request is at t; it expires 60s later, ~57s after t+3000.
    expect(res.retryAfterSec).toBe(57)
  })

  it('does not record blocked requests (the window count stays at the limit)', () => {
    const q = new QuotaManager(makeConfig({ maxRequestsPerMinute: 2 }))
    const t = 1_000_000
    q.checkRpm(t)
    q.checkRpm(t + 1)
    q.checkRpm(t + 2) // blocked, not recorded
    q.checkRpm(t + 3) // blocked, not recorded
    expect(q.requestsInWindow(t + 3)).toBe(2)
  })

  it('slides the window so old requests expire and new ones are allowed again', () => {
    const q = new QuotaManager(makeConfig({ maxRequestsPerMinute: 2 }))
    const t = 1_000_000
    expect(q.checkRpm(t).allowed).toBe(true)
    expect(q.checkRpm(t + 1000).allowed).toBe(true)
    expect(q.checkRpm(t + 2000).allowed).toBe(false)
    // 61s after the first request: both originals are outside the 60s window.
    const later = t + 61_000
    expect(q.checkRpm(later).allowed).toBe(true)
    expect(q.requestsInWindow(later)).toBe(1)
  })

  it('partially slides: only the expired request frees a slot', () => {
    const q = new QuotaManager(makeConfig({ maxRequestsPerMinute: 2 }))
    const t = 1_000_000
    q.checkRpm(t)
    q.checkRpm(t + 30_000)
    // At t+61_000 the first (t) has expired but the second (t+30_000) has not.
    const res = q.checkRpm(t + 61_000)
    expect(res.allowed).toBe(true)
    // Now full again with t+30_000 and t+61_000.
    expect(q.checkRpm(t + 61_001).allowed).toBe(false)
  })

  it('defaults now to wall-clock time when omitted', () => {
    const q = new QuotaManager(makeConfig({ maxRequestsPerMinute: 1 }))
    expect(q.checkRpm().allowed).toBe(true)
    expect(q.checkRpm().allowed).toBe(false)
  })
})

describe('QuotaManager — token estimator and session budget', () => {
  it('estimates tokens as ceil(length / 4)', () => {
    const q = new QuotaManager(makeConfig())
    expect(q.estimateTokens('')).toBe(0)
    expect(q.estimateTokens('abc')).toBe(1)
    expect(q.estimateTokens('abcd')).toBe(1)
    expect(q.estimateTokens('abcde')).toBe(2)
    expect(q.estimateTokens('a'.repeat(40))).toBe(10)
  })

  it('accumulates tokens and trips once the budget is exceeded', () => {
    const q = new QuotaManager(makeConfig({ maxTokensPerSession: 100 }))
    expect(q.sessionExceeded()).toBe(false)
    q.addTokens(60)
    expect(q.tokensUsed()).toBe(60)
    expect(q.sessionExceeded()).toBe(false)
    q.addTokens(40)
    // Exactly at the budget is NOT exceeded (strictly greater).
    expect(q.tokensUsed()).toBe(100)
    expect(q.sessionExceeded()).toBe(false)
    q.addTokens(1)
    expect(q.sessionExceeded()).toBe(true)
  })
})

describe('QuotaManager — rolling token budget window', () => {
  it('auto-resets the token budget after the window elapses', () => {
    const q = new QuotaManager(makeConfig({ maxTokensPerSession: 100, tokenBudgetWindowMs: 1000 }))
    const t = 5_000_000
    q.addTokens(120, t)
    expect(q.sessionExceeded(t)).toBe(true)
    // Still exceeded just before the window closes.
    expect(q.sessionExceeded(t + 999)).toBe(true)
    // At/after the window the budget rolls over and resets to 0.
    expect(q.sessionExceeded(t + 1000)).toBe(false)
    expect(q.tokensUsed()).toBe(0)
  })

  it('treats tokenBudgetWindowMs=0 as a lifetime budget that never resets', () => {
    const q = new QuotaManager(makeConfig({ maxTokensPerSession: 100, tokenBudgetWindowMs: 0 }))
    const t = 5_000_000
    q.addTokens(120, t)
    expect(q.sessionExceeded(t)).toBe(true)
    // Far in the future, still exceeded (no auto-reset).
    expect(q.sessionExceeded(t + 10 * 3_600_000)).toBe(true)
  })

  it('defaults to a 1-hour window when tokenBudgetWindowMs is omitted', () => {
    const q = new QuotaManager(makeConfig({ maxTokensPerSession: 100 }))
    const t = 5_000_000
    q.addTokens(120, t)
    expect(q.sessionExceeded(t + 60_000)).toBe(true)     // within the hour
    expect(q.sessionExceeded(t + 3_600_000)).toBe(false) // after the hour → reset
  })
})

describe('QuotaManager — reset', () => {
  it('clears both rate-limit and token state', () => {
    const q = new QuotaManager(makeConfig({ maxRequestsPerMinute: 1, maxTokensPerSession: 10 }))
    const t = 1_000_000
    q.checkRpm(t)
    q.addTokens(100)
    expect(q.requestsInWindow(t)).toBe(1)
    expect(q.sessionExceeded()).toBe(true)

    q.reset()

    expect(q.requestsInWindow(t)).toBe(0)
    expect(q.tokensUsed()).toBe(0)
    expect(q.sessionExceeded()).toBe(false)
    expect(q.checkRpm(t).allowed).toBe(true)
  })
})
