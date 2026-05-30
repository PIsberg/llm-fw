import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

describe('EventBus — SSE heartbeat (FIX-6)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('FIX-6: sends SSE comment heartbeat (:\\n\\n) to subscribers every 15 seconds', () => {
    const bus = new EventBus(DEFAULT_CONFIG.dashboard)

    const written: string[] = []
    const fakeSub = {
      writableEnded: false,
      destroyed: false,
      writeHead: vi.fn(),
      write: vi.fn((data: string) => { written.push(data) }),
      on: vi.fn(),
    } as any

    bus.subscribe(fakeSub)
    written.length = 0 // clear the replay writes from subscribe()

    // No heartbeat before 15s
    vi.advanceTimersByTime(14_999)
    const heartbeats = written.filter(d => d === ':\n\n')
    expect(heartbeats).toHaveLength(0)

    // First heartbeat fires at exactly 15s
    vi.advanceTimersByTime(1)
    expect(written.filter(d => d === ':\n\n')).toHaveLength(1)

    // Second heartbeat at 30s
    vi.advanceTimersByTime(15_000)
    expect(written.filter(d => d === ':\n\n')).toHaveLength(2)

    bus.destroy()
  })

  it('FIX-6: destroy() stops the heartbeat timer', () => {
    const bus = new EventBus(DEFAULT_CONFIG.dashboard)

    const written: string[] = []
    const fakeSub = {
      writableEnded: false,
      destroyed: false,
      writeHead: vi.fn(),
      write: vi.fn((data: string) => { written.push(data) }),
      on: vi.fn(),
    } as any

    bus.subscribe(fakeSub)
    written.length = 0

    bus.destroy()

    // After destroy, advancing 60s must produce no heartbeats
    vi.advanceTimersByTime(60_000)
    expect(written.filter(d => d === ':\n\n')).toHaveLength(0)
  })

  it('dead subscribers are pruned before sending heartbeat', () => {
    const bus = new EventBus(DEFAULT_CONFIG.dashboard)

    const alive = {
      writableEnded: false, destroyed: false,
      writeHead: vi.fn(), write: vi.fn(), on: vi.fn(),
    } as any
    const dead = {
      writableEnded: true, destroyed: false,
      writeHead: vi.fn(), write: vi.fn(), on: vi.fn(),
    } as any

    bus.subscribe(alive)
    bus.subscribe(dead)

    vi.advanceTimersByTime(15_000)

    expect(alive.write).toHaveBeenCalledWith(':\n\n')
    expect(dead.write).not.toHaveBeenCalledWith(':\n\n')

    bus.destroy()
  })
})
