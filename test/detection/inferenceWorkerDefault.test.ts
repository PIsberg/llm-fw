import { describe, it, expect, vi, beforeEach } from 'vitest'

// Inference runs on a worker thread by default, so a forward pass no longer holds
// the thread serving every client. These pin what that must not cost. A worker that
// cannot start used to disable the stage, which on a default path would quietly
// stop reading text the firewall claims to read, so it has to fall back instead.

const { vector, inProcess, pipelineLoad, moduleLoaded } = vi.hoisted(() => {
  const vector = new Float32Array(384).fill(0.1)
  const inProcess = vi.fn(async () => ({ data: vector }))
  return { vector, inProcess, pipelineLoad: vi.fn(async () => inProcess as unknown), moduleLoaded: vi.fn() }
})
vi.mock('@huggingface/transformers', () => {
  moduleLoaded()
  return {
    env: {},
    pipeline: (...args: unknown[]) => (pipelineLoad as (...a: unknown[]) => Promise<unknown>)(...args),
  }
})

import { EmbeddingChecker } from '../../src/detection/embedding.js'
import { InjectionClassifier } from '../../src/detection/classifier.js'
import type { InferenceWorkerClient } from '../../src/detection/inferenceWorker.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

const detection = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_CONFIG.detection, workerInference: true, modelLoadTimeoutMs: 5_000, ...over })

function client(over: Partial<Record<'ensure' | 'embed' | 'classify' | 'isAvailable', unknown>> = {}): InferenceWorkerClient {
  return {
    ensure: vi.fn(() => Promise.resolve()),
    embed: vi.fn(() => Promise.resolve(vector)),
    classify: vi.fn(() => Promise.resolve([{ label: 'SAFE', score: 0.99 }])),
    isAvailable: vi.fn(() => true),
    ...over,
  } as unknown as InferenceWorkerClient
}

describe('inference on a worker thread', () => {
  beforeEach(() => {
    inProcess.mockClear()
    pipelineLoad.mockClear()
  })

  describe('a worker that cannot start', () => {
    const failing = () => client({
      ensure: vi.fn(() => Promise.reject(new Error('inference worker exited with code 1'))),
      embed: vi.fn(() => Promise.reject(new Error('inference worker exited with code 1'))),
      classify: vi.fn(() => Promise.reject(new Error('inference worker exited with code 1'))),
    })

    it('embedding: falls back to in-process rather than disabling the stage', async () => {
      const worker = failing()
      const checker = new EmbeddingChecker(detection(), worker)
      await checker.init()
      expect(checker.isInitialized()).toBe(true)
      expect(pipelineLoad).toHaveBeenCalledTimes(1)
      await expect(checker.check('a text the cache has not seen')).resolves.toMatchObject({ chunkCount: 1 })
      // Once on the fallback it stays there: asking the dead worker first would
      // fail every scan.
      expect(worker.embed).not.toHaveBeenCalled()
    })

    it('classifier: falls back to in-process rather than disabling the stage', async () => {
      const worker = failing()
      const classifier = new InjectionClassifier(detection({ classifier: { ...DEFAULT_CONFIG.detection.classifier, enabled: true } }), worker)
      await classifier.init()
      expect(classifier.isInitialized()).toBe(true)
      expect(pipelineLoad).toHaveBeenCalledTimes(1)
      expect(worker.classify).not.toHaveBeenCalled()
    })

    it('embedding: still disables the stage when the model itself cannot load', async () => {
      pipelineLoad.mockImplementationOnce(async () => { throw new Error('offline') })
      const checker = new EmbeddingChecker(detection(), failing())
      await checker.init()
      expect(checker.isInitialized()).toBe(false)
    })
  })

  // Hot reload mutates the config object in place. The stage must not report
  // itself off, and so go unread, because the flag changed.
  it('embedding: stays initialized when the flag is switched off live', async () => {
    const config = detection()
    const checker = new EmbeddingChecker(config, client())
    await checker.init()
    config.workerInference = false
    expect(checker.isInitialized()).toBe(true)
    await expect(checker.check('another text the cache has not seen')).resolves.toMatchObject({ chunkCount: 1 })
    expect(pipelineLoad).toHaveBeenCalledTimes(1)
  })

  it('classifier: stays initialized when the flag is switched off live', async () => {
    const config = detection({ classifier: { ...DEFAULT_CONFIG.detection.classifier, enabled: true } })
    const classifier = new InjectionClassifier(config, client())
    await classifier.init()
    config.workerInference = false
    expect(classifier.isInitialized()).toBe(true)
  })

  it('embedding: stays initialized when the flag is switched on live', async () => {
    const config = detection({ workerInference: false })
    const worker = client()
    const checker = new EmbeddingChecker(config, worker)
    await checker.init()
    config.workerInference = true
    expect(checker.isInitialized()).toBe(true)
    await checker.check('a third text the cache has not seen')
    expect(worker.embed).toHaveBeenCalled()
  })
})
