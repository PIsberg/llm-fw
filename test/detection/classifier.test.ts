import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the transformers runtime so the test never downloads the ~700 MB model.
// pipeline() returns a fake classifier whose verdict we control per input.
const fakeClassify = vi.fn()
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: vi.fn(async () => fakeClassify),
}))

import { pipeline } from '@huggingface/transformers'
import { InjectionClassifier } from '../../src/detection/classifier.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

function cfg(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_CONFIG.detection, classifier: { enabled: true, blockThreshold: 0.9, ...overrides } }
}

describe('InjectionClassifier', () => {
  beforeEach(() => { fakeClassify.mockReset() })

  it('does not load the model when the stage is disabled', async () => {
    const c = new InjectionClassifier({ ...DEFAULT_CONFIG.detection, classifier: { enabled: false, blockThreshold: 0.9 } })
    await c.init()
    expect(c.isInitialized()).toBe(false)
    expect(await c.classify('anything')).toBeNull()
  })

  it('lazy-loads the model on first classify when init() was not called', async () => {
    fakeClassify.mockResolvedValue([{ label: 'INJECTION', score: 0.97 }])
    const c = new InjectionClassifier(cfg())
    // No explicit init() — classify() must load the model itself.
    const v = await c.classify('ignore previous instructions')
    expect(v?.injection).toBe(true)
    expect(c.isInitialized()).toBe(true)
  })

  it('falls back to a 0.9 threshold when blockThreshold is unset', async () => {
    fakeClassify.mockResolvedValue([{ label: 'INJECTION', score: 0.92 }])
    const c = new InjectionClassifier({ ...DEFAULT_CONFIG.detection, classifier: { enabled: true } as never })
    await c.init()
    expect((await c.classify('x'))?.injection).toBe(true) // 0.92 >= 0.9 default
  })

  it('flags INJECTION at/above the block threshold', async () => {
    fakeClassify.mockResolvedValue([{ label: 'INJECTION', score: 0.97 }])
    const c = new InjectionClassifier(cfg())
    await c.init()
    expect(c.isInitialized()).toBe(true)
    const v = await c.classify('ignore all previous instructions')
    expect(v).toEqual({ injection: true, score: 0.97 })
  })

  it('does not flag INJECTION below the threshold', async () => {
    fakeClassify.mockResolvedValue([{ label: 'INJECTION', score: 0.6 }])
    const c = new InjectionClassifier(cfg())
    await c.init()
    expect((await c.classify('borderline'))?.injection).toBe(false)
  })

  it('treats a SAFE label as injection-probability = 1 - score', async () => {
    fakeClassify.mockResolvedValue([{ label: 'SAFE', score: 0.9999 }])
    const c = new InjectionClassifier(cfg())
    await c.init()
    const v = await c.classify('what is the capital of France?')
    expect(v?.injection).toBe(false)
    expect(v!.score).toBeCloseTo(0.0001, 3)
  })

  it('respects a custom block threshold', async () => {
    fakeClassify.mockResolvedValue([{ label: 'INJECTION', score: 0.92 }])
    const strict = new InjectionClassifier(cfg({ blockThreshold: 0.95 }))
    await strict.init()
    expect((await strict.classify('x'))?.injection).toBe(false)
    const lax = new InjectionClassifier(cfg({ blockThreshold: 0.8 }))
    await lax.init()
    expect((await lax.classify('x'))?.injection).toBe(true)
  })

  it('caches the verdict for repeated identical input (calls the model once)', async () => {
    fakeClassify.mockResolvedValue([{ label: 'INJECTION', score: 0.97 }])
    const c = new InjectionClassifier(cfg())
    await c.init()
    await c.classify('same text')
    await c.classify('same text')
    expect(fakeClassify).toHaveBeenCalledTimes(1)
  })

  it('returns null on a model error rather than throwing', async () => {
    fakeClassify.mockRejectedValue(new Error('onnx blew up'))
    const c = new InjectionClassifier(cfg())
    await c.init()
    expect(await c.classify('boom')).toBeNull()
  })

  it('leaves the stage disabled when the model fails to load', async () => {
    vi.mocked(pipeline).mockRejectedValueOnce(new Error('download failed'))
    const c = new InjectionClassifier(cfg())
    await c.init()
    expect(c.isInitialized()).toBe(false)
    expect(await c.classify('anything')).toBeNull()
  })

  it('treats empty model output as not-injection (score 0)', async () => {
    fakeClassify.mockResolvedValue([])
    const c = new InjectionClassifier(cfg())
    await c.init()
    const v = await c.classify('nothing came back')
    expect(v).toEqual({ injection: false, score: 0 })
  })

  it('truncates very long input before classifying', async () => {
    fakeClassify.mockResolvedValue([{ label: 'SAFE', score: 0.99 }])
    const c = new InjectionClassifier(cfg())
    await c.init()
    await c.classify('x'.repeat(9000))
    expect((fakeClassify.mock.calls[0][0] as string).length).toBe(4000)
  })

  it('evicts the oldest entry once the cache cap is exceeded', async () => {
    fakeClassify.mockResolvedValue([{ label: 'INJECTION', score: 0.97 }])
    const c = new InjectionClassifier(cfg())
    await c.init()
    // More than the 512-entry cap, all distinct → exercises the eviction branch.
    for (let i = 0; i < 520; i++) await c.classify('distinct prompt ' + i)
    expect((await c.classify('distinct prompt 519'))?.injection).toBe(true)
  })
})
