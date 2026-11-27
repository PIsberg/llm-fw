import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogger, withRequestId, currentRequestId, urlForLog, parseTraceparent } from '../src/logger.js'

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

// #874: the logger must never throw on what a caller hands it, and the
// fields that identify a record must not be overwritten by them.
describe('structured logger: fields it is handed (#874)', () => {
  it('logs a circular object instead of throwing', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    const rec = capture(() => createLogger('t').warn('cycle', { a }))
    expect(rec.msg).toBe('cycle')
    expect((rec.a as Record<string, unknown>).self).toBe('[Circular]')
  })

  it('keeps an object that appears twice without being circular', () => {
    const shared = { id: 1 }
    const rec = capture(() => createLogger('t').warn('shared', { left: shared, right: shared }))
    expect(rec.left).toEqual({ id: 1 })
    expect(rec.right).toEqual({ id: 1 })
  })

  it('logs a BigInt as its decimal string, and unpacks a nested Error', () => {
    const rec = capture(() => createLogger('t').warn('big', { n: 12345678901234567890n, nested: { err: new Error('deep') } }))
    expect(rec.n).toBe('12345678901234567890')
    expect((rec.nested as { err: { message: string } }).err.message).toBe('deep')
  })

  it('still writes the record when a field cannot be serialised at all', () => {
    const bad = { toJSON() { throw new Error('nope') } }
    const rec = capture(() => createLogger('t').warn('kept', { bad }))
    expect(rec.msg).toBe('kept')
    expect(rec.level).toBe('warn')
    expect(typeof rec.logError).toBe('string')
  })

  it('does not let a field overwrite the envelope', () => {
    const rec = withRequestId('real-id', () => capture(() => createLogger('gateway').warn('real message', {
      level: 'debug', time: 'then', scope: 'forged', msg: 'forged message', requestId: 'forged-id', traceId: 'forged-trace', detail: 1,
    }), 'warn'))
    expect(rec.level).toBe('warn')
    expect(rec.scope).toBe('gateway')
    expect(rec.msg).toBe('real message')
    expect(rec.requestId).toBe('real-id')
    expect(rec.time).not.toBe('then')
    expect(rec.detail).toBe(1)
  })
})

describe('W3C traceparent (#874)', () => {
  const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

  it('parses a valid header into its trace and span ids', () => {
    expect(parseTraceparent(TP)).toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' })
    expect(parseTraceparent(`  ${TP}  `)).toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' })
    // A later version may append fields after the four the spec fixes.
    expect(parseTraceparent(`01${TP.slice(2)}-extra`)?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['version ff', 'ff' + TP.slice(2)],
    ['all-zero trace id', '00-00000000000000000000000000000000-00f067aa0ba902b7-01'],
    ['all-zero span id', '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'],
    ['upper-case hex', TP.toUpperCase()],
    ['short trace id', '00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01'],
    ['version 00 with extra fields', TP + '-extra'],
    ['a list of two headers', [TP, TP]],
    ['over 512 characters', TP + '-' + 'a'.repeat(600)],
  ])('ignores a header that is %s', (_name, header) => {
    expect(parseTraceparent(header as string | string[] | undefined)).toBeNull()
  })

  it('puts traceId and spanId on every record inside the request scope', () => {
    const trace = parseTraceparent(TP)
    const rec = withRequestId('rid', () => capture(() => createLogger('t').warn('traced')), trace)
    expect(rec.requestId).toBe('rid')
    expect(rec.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(rec.spanId).toBe('00f067aa0ba902b7')
    const plain = withRequestId('rid', () => capture(() => createLogger('t').warn('untraced')))
    expect(plain.traceId).toBeUndefined()
  })
})

describe('urlForLog', () => {
  // Error logs printed req.url whole. Google takes its API key as ?key=, Azure
  // as ?api-key=, OAuth endpoints as ?access_token=, so one failed request put
  // a provider credential in the log.
  it('keeps the path and parameter names and drops every value', () => {
    const line = urlForLog('/v1beta/models/gemini-2.5-pro:generateContent?key=AIzaSECRET&alt=sse')
    expect(line).toBe('/v1beta/models/gemini-2.5-pro:generateContent?key=…&alt=…')
    expect(line).not.toContain('AIzaSECRET')
  })

  it('leaves a path with no query alone', () => {
    expect(urlForLog('/v1/messages')).toBe('/v1/messages')
  })

  it('handles a missing url and a bare question mark', () => {
    expect(urlForLog(undefined)).toBe('/')
    expect(urlForLog('/v1/messages?')).toBe('/v1/messages')
  })
})
