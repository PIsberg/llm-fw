import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Lifecycle } from '../../src/cli/lifecycle.js'

// #863: `llm-fw start` registered its SIGINT/SIGTERM handler before the
// resources it closed were declared, so a signal during startup threw a
// ReferenceError from the handler; a second signal ran the teardown again;
// a teardown step that never settled kept the process alive; and the proxy,
// dashboard, event bus and modules were never closed at all. The lifecycle
// closes what has been registered so far, once, and exits within a bound.
describe('Lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const make = () => {
    const exit = vi.fn()
    const cleanup = vi.fn()
    const log = vi.fn()
    return { exit, cleanup, log, lc: new Lifecycle({ exit, cleanup, log, timeoutMs: 1000 }) }
  }

  it('stops cleanly when asked before anything was registered', async () => {
    const { lc, exit, cleanup } = make()
    lc.stop()
    await vi.runAllTimersAsync()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('closes everything registered, and only once however often it is asked', async () => {
    const { lc, exit, cleanup } = make()
    const a = vi.fn(async () => {})
    const b = vi.fn()
    lc.add('proxy', a)
    lc.add('dashboard', b)
    lc.stop()
    lc.stop()
    await vi.runAllTimersAsync()
    lc.stop()
    await vi.runAllTimersAsync()
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
  })

  it('exits after the bound when a step never settles, and says which', async () => {
    const { lc, exit, log } = make()
    lc.add('audit webhook', () => new Promise(() => {}))
    lc.add('proxy', async () => {})
    lc.stop()
    await vi.advanceTimersByTimeAsync(999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledWith(0)
    expect(log.mock.calls.flat().join(' ')).toContain('audit webhook')
  })

  it('closes the rest when one step throws or rejects, and reports it', async () => {
    const { lc, exit, log } = make()
    const after = vi.fn()
    lc.add('pipeline', () => { throw new Error('boom') })
    lc.add('gateway', () => Promise.reject(new Error('nope')))
    lc.add('modules', after)
    lc.stop()
    await vi.runAllTimersAsync()
    expect(after).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
    const logged = log.mock.calls.flat().join(' ')
    expect(logged).toContain('pipeline')
    expect(logged).toContain('gateway')
  })

  it('exits with the code it was given', async () => {
    const { lc, exit } = make()
    lc.stop(1)
    await vi.runAllTimersAsync()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('keeps exiting even when cleanup throws', async () => {
    const exit = vi.fn()
    const lc = new Lifecycle({ exit, cleanup: () => { throw new Error('hosts file locked') }, log: vi.fn(), timeoutMs: 1000 })
    lc.stop()
    await vi.runAllTimersAsync()
    expect(exit).toHaveBeenCalledWith(0)
  })
})
