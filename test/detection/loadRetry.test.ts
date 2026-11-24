import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// #869: a model load that failed once stayed failed for the life of the
// process. A Hugging Face 429 or one dropped connection at startup turned a
// stage off until a restart. A failure is now forgotten after a cooldown.
const pipelineMock = vi.fn()
vi.mock('../../src/detection/modelLoad.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadTransformers: async () => ({ pipeline: pipelineMock }),
}))

const createWorkerMock = vi.fn()
vi.mock('tesseract.js', () => ({ createWorker: createWorkerMock }))

import { cachedLoad, LOAD_RETRY_MS } from '../../src/detection/modelLoad.js'
import { ocrImage, terminateOcr } from '../../src/detection/ocr.js'
import { InjectionClassifier } from '../../src/detection/classifier.js'
import { OutputModerationClassifier } from '../../src/detection/outputClassifier.js'
import { transcribeAudio } from '../../src/detection/transcribe.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); pipelineMock.mockReset() })
afterEach(() => vi.useRealTimers())
const later = () => vi.setSystemTime(Date.now() + LOAD_RETRY_MS + 1)

describe('cachedLoad (#869)', () => {
  it('shares one load, keeps a failure for the cooldown, then loads again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValue('model')
    const get = cachedLoad(load)
    await expect(get()).rejects.toThrow('429')
    await expect(get()).rejects.toThrow('429')
    expect(load).toHaveBeenCalledTimes(1)
    later()
    await expect(get()).resolves.toBe('model')
    await expect(get()).resolves.toBe('model')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('counts a load that resolves to a failure value as failed', async () => {
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValue('worker')
    const get = cachedLoad(load, { failed: v => v === null })
    expect(await get()).toBeNull()
    expect(await get()).toBeNull()
    later()
    expect(await get()).toBe('worker')
  })
})

describe('the classifiers load again after a failed load (#869)', () => {
  const classifyFn = Object.assign(vi.fn().mockResolvedValue([{ label: 'SAFE', score: 0.99 }]), { tokenizer: undefined })

  it('InjectionClassifier', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('503')).mockResolvedValue(classifyFn)
    const c = new InjectionClassifier({ ...DEFAULT_CONFIG.detection, workerInference: false, classifier: { ...DEFAULT_CONFIG.detection.classifier!, enabled: true } })
    await c.init()
    expect(c.isInitialized()).toBe(false)
    expect(await c.classify('hello there')).toBeNull()
    later()
    // The retry runs behind the request that started it, which skips the stage.
    expect(await c.classify('hello there')).toBeNull()
    await vi.waitFor(() => expect(c.isInitialized()).toBe(true))
    expect(await c.classify('hello there')).not.toBeNull()
  })

  it('OutputModerationClassifier', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('503')).mockResolvedValue(classifyFn)
    const c = new OutputModerationClassifier({ ...DEFAULT_CONFIG.responseScan!, classifier: { ...DEFAULT_CONFIG.responseScan!.classifier!, enabled: true } })
    await c.init()
    expect(c.isInitialized()).toBe(false)
    later()
    expect(await c.classify('some response')).toBeNull()
    await vi.waitFor(() => expect(c.isInitialized()).toBe(true))
    expect(await c.classify('some response')).not.toBeNull()
  })
})

describe('transcription loads again after a failed load (#869)', () => {
  it('transcribes once the cooldown has passed', async () => {
    const asr = vi.fn().mockResolvedValue({ text: 'hello world' })
    pipelineMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(asr)
    // 0.1 s of 16 kHz mono silence as WAV.
    const pcm = Buffer.alloc(3200)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
    const wav = Buffer.concat([header, pcm]).toString('base64')
    expect(await transcribeAudio(wav, 'audio/wav')).toBe('')
    expect(await transcribeAudio(wav, 'audio/wav')).toBe('')
    expect(pipelineMock).toHaveBeenCalledTimes(1)
    later()
    expect(await transcribeAudio(wav, 'audio/wav')).toBe('hello world')
  })
})

describe('OCR loads again after a failed load (#869)', () => {
  it('reads the image once the cooldown has passed', async () => {
    const recognize = vi.fn().mockResolvedValue({ data: { text: 'read me' } })
    createWorkerMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ recognize, terminate: vi.fn() })
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
    expect(await ocrImage(png, 'image/png')).toBe('')
    expect(await ocrImage(png, 'image/png')).toBe('')
    expect(createWorkerMock).toHaveBeenCalledTimes(1)
    later()
    expect(await ocrImage(png, 'image/png')).toBe('read me')
    await terminateOcr()
  })
})
