import { it, expect, vi } from 'vitest'

// The transformers runtime is about 140 MB of RSS. With inference on the worker
// thread the main thread never needs it, and a static import paid for it twice.
// Its own file, and every import below is dynamic: anything importing these modules
// at the top of the file would load the runtime before the test could look.

const { loaded } = vi.hoisted(() => ({ loaded: vi.fn() }))
vi.mock('@huggingface/transformers', () => {
  loaded()
  return { env: {}, pipeline: vi.fn() }
})

it('does not load the transformers runtime on the main thread', async () => {
  const { EmbeddingChecker } = await import('../../src/detection/embedding.js')
  const { InjectionClassifier } = await import('../../src/detection/classifier.js')
  await import('../../src/detection/outputClassifier.js')
  await import('../../src/detection/transcribe.js')
  await import('../../src/detection/pipeline.js')
  const { DEFAULT_CONFIG } = await import('../../src/config/config.js')

  const client = {
    ensure: vi.fn(() => Promise.resolve()),
    embed: vi.fn(() => Promise.resolve(new Float32Array(384).fill(0.1))),
    classify: vi.fn(() => Promise.resolve([{ label: 'SAFE', score: 0.99 }])),
    isAvailable: vi.fn(() => true),
  } as never
  const detection = { ...DEFAULT_CONFIG.detection, workerInference: true, classifier: { ...DEFAULT_CONFIG.detection.classifier, enabled: true } }
  const checker = new EmbeddingChecker(detection, client)
  await checker.init()
  await checker.check('a text the cache has not seen')
  const classifier = new InjectionClassifier(detection, client)
  await classifier.init()

  expect(loaded).not.toHaveBeenCalled()
})
