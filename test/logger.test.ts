import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogger, withRequestId, currentRequestId } from '../src/logger.js'

/**
 * The logger exists because `console.log` gives an operator no level to filter
 * on, no structure to ship, and no way to join the lines one request produced.
 * What is pinned here is exactly those three things, plus the two properties
 * that matter for a security product: it must not turn an Error into `{}`, and
 * routing through console must keep working for everything that already
 * asserts on console.
 */
const ENV = ['LLM_FW_LOG_LEVEL', 'LLM_FW_LOG_FORMAT'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k] }
  process.env.LLM_FW_LOG_FORMAT = 'json'
})
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.restoreAllMocks()
})

/** Capture one JSON record from the console sink. */
function capture(fn: () => void, method: 'log' | 'warn' | 'error' = 'warn'): Record<string, unknown> {
  const spy = vi.spyOn(console, method).mockImplementation(() => {})
  try {
    fn()
    expect(spy).toHaveBeenCalledTimes(1)
    return JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>
  } finally {
    // Restore between captures: two captures of the same method in one test
    // would otherwise share a spy and count each other's calls.
    spy.mockRestore()
  }
}

describe('structured logger', () => {
  it('emits JSON carrying the level, scope and message', () => {
    const rec = capture(() => createLogger('gateway').warn('upstream refused'))
    expect(rec.level).toBe('warn')
    expect(rec.scope).toBe('gateway')
    expect(rec.msg).toBe('upstream refused')
    expect(typeof rec.time).toBe('string')
  })

  it('routes each level to the console method that matches it', () => {
    // stdout for information, stderr for problems: a collector and a shell
    // redirect both rely on that split.
    capture(() => createLogger('s').info('i'), 'log')
    capture(() => createLogger('s').warn('w'), 'warn')
    capture(() => createLogger('s').error('e'), 'error')
    capture(() => createLogger('s').fatal('f'), 'error')
  })

  it('filters below the configured level', () => {
    process.env.LLM_FW_LOG_LEVEL = 'error'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = createLogger('s')
    log.warn('dropped')
    log.error('kept')
    expect(warn).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('defaults to info, so debug is off until asked for', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    createLogger('s').debug('noisy')
    expect(spy).not.toHaveBeenCalled()
  })

  it('unpacks an Error, which JSON.stringify would otherwise render as {}', () => {
    expect(JSON.stringify({ err: new Error('boom') })).toBe('{"err":{}}')
    const rec = capture(() => createLogger('s').error('failed', { err: new Error('boom') }), 'error')
    const err = rec.err as Record<string, unknown>
    expect(err.message).toBe('boom')
    expect(err.name).toBe('Error')
    expect(typeof err.stack).toBe('string')
  })

  it('attaches a correlation id to everything inside the request scope', () => {
    const rec = capture(() => withRequestId('req-42', () => createLogger('proxy').warn('slow')))
    expect(rec.requestId).toBe('req-42')
  })

  it('carries the id across an await, not just the synchronous frame', async () => {
    // The point of AsyncLocalStorage over a parameter: the detection pipeline
    // does not have to know it is serving a request.
    const seen = await withRequestId('req-async', async () => {
      await new Promise(r => setTimeout(r, 1))
      return currentRequestId()
    })
    expect(seen).toBe('req-async')
  })

  it('omits the id entirely when there is no request', () => {
    const rec = capture(() => createLogger('s').warn('startup'))
    expect(rec.requestId).toBeUndefined()
    expect(currentRequestId()).toBeUndefined()
  })

  it('keeps the message readable in pretty mode, in the shape the code used before', () => {
    process.env.LLM_FW_LOG_FORMAT = 'pretty'
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createLogger('gateway').warn('upstream refused')
    expect(spy).toHaveBeenCalledWith('[gateway] upstream refused')
  })

  it('keeps a substring assertion on console working, which is how the existing suites check warnings', () => {
    // 8 test files already assert `expect(warn).toHaveBeenCalledWith(
    // expect.stringContaining('...'))`. Emitting JSON through console keeps
    // every one of them passing, which is why the sink is console.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createLogger('embedding').warn('embedding model unavailable — semantic similarity stage disabled')
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('embedding model unavailable'))
  })
})
