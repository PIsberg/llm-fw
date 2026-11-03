import { describe, it, expect, vi, beforeEach } from 'vitest'

// Everything here loads or runs something that never answers: a blackholed model
// download, a wedged tesseract worker. Each of these used to wait for ever, and
// the first request to reach one took every later request with it. The failure
// policy is not new: it is the one a failed load already had (stage disabled, or
// opaque handling), now also reached when nothing fails and nothing arrives.

const never = <T>(): Promise<T> => new Promise<T>(() => {})
const pipelineLoad = vi.fn(() => never<unknown>())
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: (...args: unknown[]) => (pipelineLoad as (...a: unknown[]) => Promise<unknown>)(...args),
}))
const createWorker = vi.fn(() => never<unknown>())
vi.mock('tesseract.js', () => ({ createWorker: () => createWorker() }))

import { EmbeddingChecker } from '../../src/detection/embedding.js'
import { InjectionClassifier } from '../../src/detection/classifier.js'
import { OutputModerationClassifier } from '../../src/detection/outputClassifier.js'
import { InferenceWorkerClient, WorkerUnavailableError } from '../../src/detection/inferenceWorker.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { ResponseScanConfig } from '../../src/types.js'

const BOUND_MS = 40
/** Fails the test instead of hanging the suite when the code under test hangs. */
const settled = <T>(p: Promise<T>): Promise<T | 'still waiting'> =>
  Promise.race([p, new Promise<'still waiting'>(r => setTimeout(() => r('still waiting'), 2_000))])

function wav(): string {
  const samples = 800
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16_000, 24)
  b.writeUInt32LE(32_000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  return b.toString('base64')
}
// 1x1 PNG: OCR only checks the MIME type and that the base64 decodes.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const detection = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_CONFIG.detection, modelLoadTimeoutMs: BOUND_MS, ...over })

function stuckClient(over: Partial<Record<'ensure' | 'embed' | 'classify' | 'isAvailable', unknown>> = {}): InferenceWorkerClient {
  return {
    ensure: vi.fn(() => never<void>()),
    embed: vi.fn(() => never<Float32Array>()),
    classify: vi.fn(() => never<unknown>()),
    isAvailable: vi.fn(() => true),
    ...over,
  } as unknown as InferenceWorkerClient
}

describe('model loads that never finish', () => {
  beforeEach(() => {
    pipelineLoad.mockReset()
    pipelineLoad.mockImplementation(() => never<unknown>())
    createWorker.mockReset()
    createWorker.mockImplementation(() => never<unknown>())
  })

  it('embedding, in-process: disables the stage (the existing bound)', async () => {
    const checker = new EmbeddingChecker(detection())
    expect(await settled(checker.init())).toBeUndefined()
    expect(checker.isInitialized()).toBe(false)
  })

  it('embedding, in the worker: disables the stage', async () => {
    const checker = new EmbeddingChecker(detection({ workerInference: true }), stuckClient())
    expect(await settled(checker.init())).toBeUndefined()
    expect(checker.isInitialized()).toBe(false)
  })

  it('embedding, falling back from a dead worker at startup: disables the stage', async () => {
    const client = stuckClient({ ensure: vi.fn(() => Promise.reject(new WorkerUnavailableError())) })
    const checker = new EmbeddingChecker(detection({ workerInference: true }), client)
    expect(await settled(checker.init())).toBeUndefined()
    expect(checker.isInitialized()).toBe(false)
  })

  it('embedding, falling back from a worker that died later: a scan fails rather than hangs', async () => {
    let dead = false
    const vector = new Float32Array(384).fill(0.1)
    const client = stuckClient({
      ensure: vi.fn(() => Promise.resolve()),
      embed: vi.fn(() => (dead ? Promise.reject(new WorkerUnavailableError()) : Promise.resolve(vector))),
      isAvailable: vi.fn(() => !dead),
    })
    const checker = new EmbeddingChecker(detection({ workerInference: true }), client)
    await checker.init()
    expect(checker.isInitialized()).toBe(true)
    dead = true
    const outcome = await settled(checker.check('a text the cache has not seen').then(() => 'answered', () => 'failed'))
    // Failed goes to detection.failMode, which is closed by default: nothing passes unread.
    expect(outcome).toBe('failed')
  })

  it('classifier, in the worker: disables the stage', async () => {
    const classifier = new InjectionClassifier(detection({ workerInference: true, classifier: { ...DEFAULT_CONFIG.detection.classifier, enabled: true } }), stuckClient())
    expect(await settled(classifier.init())).toBeUndefined()
    expect(classifier.isInitialized()).toBe(false)
  })

  it('output classifier: disables the stage', async () => {
    const config = { enabled: true, mode: 'audit', classifier: { enabled: true, blockThreshold: 0.9 } } as ResponseScanConfig
    const classifier = new OutputModerationClassifier(config, BOUND_MS)
    expect(await settled(classifier.init())).toBeUndefined()
    expect(classifier.isInitialized()).toBe(false)
  })

  it('transcription: degrades to opaque, and later requests do not wait again', async () => {
    vi.resetModules()
    const { transcribeAudio } = await import('../../src/detection/transcribe.js')
    expect(await settled(transcribeAudio(wav(), 'audio/wav', BOUND_MS))).toBe('')
    const before = performance.now()
    expect(await settled(transcribeAudio(wav(), 'audio/wav', BOUND_MS))).toBe('')
    expect(pipelineLoad).toHaveBeenCalledTimes(1)
    expect(performance.now() - before).toBeLessThan(BOUND_MS)
  })

  // Measured for #650: 0.55 s against 1.25 s on a 3 s clip, with the same text.
  it('transcription: loads the model with onnxruntime spinning off', async () => {
    vi.resetModules()
    const { transcribeAudio } = await import('../../src/detection/transcribe.js')
    await settled(transcribeAudio(wav(), 'audio/wav', BOUND_MS))
    expect((pipelineLoad.mock.calls[0] as unknown[])[2]).toMatchObject({
      session_options: { extra: { session: { intra_op: { allow_spinning: '0' } } } },
    })
  })

  it('OCR: degrades to opaque, and later requests do not wait again', async () => {
    vi.resetModules()
    const { ocrImage } = await import('../../src/detection/ocr.js')
    expect(await settled(ocrImage(PNG, 'image/png', { loadTimeoutMs: BOUND_MS }))).toBe('')
    expect(await settled(ocrImage(PNG, 'image/png', { loadTimeoutMs: BOUND_MS }))).toBe('')
    expect(createWorker).toHaveBeenCalledTimes(1)
  })

  it('OCR: a wedged recognition degrades to opaque and the next request gets a new worker', async () => {
    vi.resetModules()
    const terminate = vi.fn(async () => {})
    createWorker.mockImplementation(() => Promise.resolve({ recognize: () => never<unknown>(), terminate }))
    const { ocrImage } = await import('../../src/detection/ocr.js')
    expect(await settled(ocrImage(PNG, 'image/png', { recognizeTimeoutMs: BOUND_MS }))).toBe('')
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(await settled(ocrImage(PNG, 'image/png', { recognizeTimeoutMs: BOUND_MS }))).toBe('')
    expect(createWorker).toHaveBeenCalledTimes(2)
  })
})
