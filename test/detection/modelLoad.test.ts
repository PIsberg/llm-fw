import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadWithVisibility, ModelLoadTimeoutError } from '../../src/detection/modelLoad.js'

/**
 * A model load that FAILS already left the firewall up with the stage
 * disabled. A model load that HANGS did not: `llm-fw start` printed "Loading
 * embedding model..." and waited forever, with no way for an operator to tell
 * a slow download from a dead one.
 *
 * These pin the bound and the heartbeat. Fake timers throughout — the point is
 * the timing contract, and a test that really waits ten minutes is a test
 * nobody runs.
 */

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A load that never settles, i.e. the black-holed download. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {})
}

describe('bounded model loading', () => {
  it('gives up on a hung load instead of waiting forever', async () => {
    vi.useFakeTimers()
    const promise = loadWithVisibility(neverSettles, { label: 'embedding model', timeoutMs: 1000, log: () => {} })
    const assertion = expect(promise).rejects.toBeInstanceOf(ModelLoadTimeoutError)

    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  })

  it('names the model and points at the cache in the error', async () => {
    vi.useFakeTimers()
    const promise = loadWithVisibility(neverSettles, { label: 'injection classifier', timeoutMs: 5000, log: () => {} })
    const assertion = expect(promise).rejects.toThrow(/injection classifier.*5s.*LLM_FW_MODEL_DIR/s)

    await vi.advanceTimersByTimeAsync(5001)
    await assertion
  })

  it('waits indefinitely when the bound is 0, preserving the old behaviour', async () => {
    vi.useFakeTimers()
    let settled = false
    void loadWithVisibility(neverSettles, { label: 'embedding model', timeoutMs: 0, log: () => {} })
      .then(() => { settled = true }, () => { settled = true })

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(settled).toBe(false)
  })

  it('returns the value untouched on the happy path', async () => {
    const extractor = { marker: 'loaded' }

    await expect(loadWithVisibility(async () => extractor, { label: 'embedding model', timeoutMs: 1000 })).resolves.toBe(extractor)
  })

  it('propagates a real load failure rather than masking it as a timeout', async () => {
    // The 429 case. It must still reach the caller's catch as itself, so the
    // existing "stage disabled" log keeps naming the actual cause.
    const boom = new Error('429 Too Many Requests')

    await expect(
      loadWithVisibility(() => Promise.reject(boom), { label: 'embedding model', timeoutMs: 10_000 }),
    ).rejects.toBe(boom)
  })

  it('reports progress while a slow load is still in flight', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const promise = loadWithVisibility(neverSettles, {
      label: 'embedding model',
      timeoutMs: 120_000,
      log: (m) => lines.push(m),
    })
    const assertion = expect(promise).rejects.toBeInstanceOf(ModelLoadTimeoutError)

    await vi.advanceTimersByTimeAsync(65_000)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[0]).toMatch(/still loading embedding model/)
    expect(lines[0]).toMatch(/LLM_FW_MODEL_DIR/)

    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('stops the heartbeat once the load completes', async () => {
    vi.useFakeTimers()
    const lines: string[] = []

    await loadWithVisibility(async () => 'ok', { label: 'embedding model', timeoutMs: 120_000, log: (m) => lines.push(m) })
    await vi.advanceTimersByTimeAsync(120_000)

    expect(lines).toEqual([])
  })
})
