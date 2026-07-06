import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the transformers runtime so the test never downloads the ~330 MB model.
// pipeline() returns a fake classifier whose verdict we control per input.
const fakeClassify = vi.fn()
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: vi.fn(async () => fakeClassify),
}))

import { pipeline } from '@huggingface/transformers'
import { OutputModerationClassifier, DEFAULT_OUTPUT_CLASSIFIER_MODEL } from '../../src/detection/outputClassifier.js'
import type { ResponseScanConfig } from '../../src/types.js'

function cfg(overrides: Record<string, unknown> = {}): ResponseScanConfig {
  return { enabled: true, mode: 'audit', classifier: { enabled: true, blockThreshold: 0.9, ...overrides } }
}

describe('OutputModerationClassifier', () => {
  beforeEach(() => {
    fakeClassify.mockReset()
    vi.mocked(pipeline).mockClear()
  })

  it('does not load the model when the stage is disabled', async () => {
    const c = new OutputModerationClassifier({ enabled: true, mode: 'audit', classifier: { enabled: false } })
    await c.init()
    expect(c.isInitialized()).toBe(false)
    expect(pipeline).not.toHaveBeenCalled()
    expect(await c.classify('anything')).toBeNull()
  })

  it('does not load the model when the classifier section is absent entirely', async () => {
    const c = new OutputModerationClassifier({ enabled: true, mode: 'audit' })
    await c.init()
    expect(pipeline).not.toHaveBeenCalled()
    expect(await c.classify('anything')).toBeNull()
  })

  it('tolerates an undefined responseScan config (proxy without the section)', async () => {
    const c = new OutputModerationClassifier(undefined)
    await c.init()
    expect(pipeline).not.toHaveBeenCalled()
    expect(await c.classify('anything')).toBeNull()
  })

  it('loads the default model id when none is configured', async () => {
    fakeClassify.mockResolvedValue([{ label: 'REJECTION', score: 0.97 }])
    const c = new OutputModerationClassifier(cfg())
    await c.init()
    expect(pipeline).toHaveBeenCalledWith('text-classification', DEFAULT_OUTPUT_CLASSIFIER_MODEL)
  })

  it('loads a configured custom model id', async () => {
    fakeClassify.mockResolvedValue([{ label: 'toxic', score: 0.97 }])
    const c = new OutputModerationClassifier(cfg({ model: 'Xenova/toxic-bert' }))
    await c.init()
    expect(pipeline).toHaveBeenCalledWith('text-classification', 'Xenova/toxic-bert')
  })

  it('lazy-loads the model on first classify when init() was not called', async () => {
    fakeClassify.mockResolvedValue([{ label: 'REJECTION', score: 0.97 }])
    const c = new OutputModerationClassifier(cfg())
    const v = await c.classify("I'm sorry, but I can't assist with that request.")
    expect(v?.flagged).toBe(true)
    expect(c.isInitialized()).toBe(true)
  })

  it('flags a non-benign label at/above the block threshold', async () => {
    fakeClassify.mockResolvedValue([{ label: 'REJECTION', score: 0.97 }])
    const c = new OutputModerationClassifier(cfg())
    await c.init()
    expect(await c.classify('refusal text')).toEqual({ flagged: true, score: 0.97 })
  })

  it('does not flag below the threshold', async () => {
    fakeClassify.mockResolvedValue([{ label: 'REJECTION', score: 0.6 }])
    const c = new OutputModerationClassifier(cfg())
    await c.init()
    expect((await c.classify('borderline'))?.flagged).toBe(false)
  })

  it('treats a benign label (NORMAL/SAFE/OK) as flagged-probability = 1 - score', async () => {
    fakeClassify.mockResolvedValue([{ label: 'NORMAL', score: 0.9999 }])
    const c = new OutputModerationClassifier(cfg())
    await c.init()
    const v = await c.classify('Here is your answer: the revenue rose 12%.')
    expect(v?.flagged).toBe(false)
    expect(v!.score).toBeCloseTo(0.0001, 3)
  })

  it('falls back to a 0.9 threshold when blockThreshold is unset', async () => {
    fakeClassify.mockResolvedValue([{ label: 'REJECTION', score: 0.92 }])
    const c = new OutputModerationClassifier({ enabled: true, mode: 'audit', classifier: { enabled: true } })
    await c.init()
    expect((await c.classify('x'))?.flagged).toBe(true) // 0.92 >= 0.9 default
  })

  it('respects a custom block threshold', async () => {
    fakeClassify.mockResolvedValue([{ label: 'REJECTION', score: 0.92 }])
    const strict = new OutputModerationClassifier(cfg({ blockThreshold: 0.95 }))
    await strict.init()
    expect((await strict.classify('x'))?.flagged).toBe(false)
    const lax = new OutputModerationClassifier(cfg({ blockThreshold: 0.8 }))
    await lax.init()
    expect((await lax.classify('x'))?.flagged).toBe(true)
  })

  it('caches the verdict for repeated identical input (calls the model once)', async () => {
    fakeClassify.mockResolvedValue([{ label: 'REJECTION', score: 0.97 }])
    const c = new OutputModerationClassifier(cfg())
    await c.init()
    await c.classify('same response')
    await c.classify('same response')
    expect(fakeClassify).toHaveBeenCalledTimes(1)
  })

  it('returns null on a model error rather than throwing', async () => {
    fakeClassify.mockRejectedValue(new Error('onnx blew up'))
    const c = new OutputModerationClassifier(cfg())
    await c.init()
    expect(await c.classify('boom')).toBeNull()
  })

  it('stays disabled (and warns) when the model fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(pipeline).mockRejectedValueOnce(new Error('download failed'))
    const c = new OutputModerationClassifier(cfg())
    await c.init()
    expect(c.isInitialized()).toBe(false)
    expect(await c.classify('anything')).toBeNull()
    // Load is attempted ONCE — classify() must not retry the download.
    expect(pipeline).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[output-classifier]'), expect.any(String))
    warn.mockRestore()
  })

  it('truncates very long responses before classifying', async () => {
    fakeClassify.mockResolvedValue([{ label: 'NORMAL', score: 0.99 }])
    const c = new OutputModerationClassifier(cfg())
    await c.init()
    await c.classify('x'.repeat(9000))
    expect((fakeClassify.mock.calls[0][0] as string).length).toBe(4000)
  })

  it('treats empty model output as not-flagged (score 0)', async () => {
    fakeClassify.mockResolvedValue([])
    const c = new OutputModerationClassifier(cfg())
    await c.init()
    expect(await c.classify('nothing came back')).toEqual({ flagged: false, score: 0 })
  })
})
