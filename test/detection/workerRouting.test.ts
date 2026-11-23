import { describe, it, expect, vi, beforeEach } from 'vitest'

// #869 part 2: with detection.workerInference on, the response moderation
// classifier and Whisper ran on the thread that serves every request (0.5 to
// 15 s a clip), each loading its own copy of the runtime there.
const pipelineMock = vi.fn()
vi.mock('../../src/detection/modelLoad.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadTransformers: async () => ({ pipeline: pipelineMock }),
}))

import { OutputModerationClassifier, DEFAULT_OUTPUT_CLASSIFIER_MODEL } from '../../src/detection/outputClassifier.js'
import { transcribeAudio } from '../../src/detection/transcribe.js'
import { WorkerUnavailableError, type InferenceWorkerClient } from '../../src/detection/inferenceWorker.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

beforeEach(() => pipelineMock.mockReset())

const scanConfig = { ...DEFAULT_CONFIG.responseScan!, classifier: { ...DEFAULT_CONFIG.responseScan!.classifier!, enabled: true } }
const fakeWorker = (over: Partial<Record<'ensure' | 'moderate' | 'transcribe', unknown>>) => ({
  ensure: vi.fn().mockResolvedValue(undefined),
  moderate: vi.fn().mockResolvedValue([{ label: 'NORMAL', score: 0.98 }]),
  transcribe: vi.fn().mockResolvedValue(' spoken words '),
  ...over,
}) as unknown as InferenceWorkerClient & Record<'ensure' | 'moderate' | 'transcribe', ReturnType<typeof vi.fn>>

function wav(): string {
  const pcm = Buffer.alloc(3200)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm]).toString('base64')
}

describe('response moderation classifier in the inference worker (#869)', () => {
  it('runs in the worker, and never loads the model on this thread', async () => {
    const worker = fakeWorker({})
    const c = new OutputModerationClassifier(scanConfig, 0, true, worker)
    const verdict = await c.classify('Sure, here is the summary you asked for.')
    expect(verdict).not.toBeNull()
    expect(worker.ensure).toHaveBeenCalledWith('moderate', undefined, DEFAULT_OUTPUT_CLASSIFIER_MODEL)
    expect(worker.moderate).toHaveBeenCalledWith(expect.any(String), DEFAULT_OUTPUT_CLASSIFIER_MODEL)
    expect(pipelineMock).not.toHaveBeenCalled()
  })

  it('falls back to this thread when the worker cannot load it', async () => {
    pipelineMock.mockResolvedValue(Object.assign(vi.fn().mockResolvedValue([{ label: 'NORMAL', score: 0.9 }]), { tokenizer: undefined }))
    const worker = fakeWorker({ ensure: vi.fn().mockRejectedValue(new Error('worker did not start')) })
    const c = new OutputModerationClassifier(scanConfig, 0, true, worker)
    expect(await c.classify('text')).not.toBeNull()
    expect(pipelineMock).toHaveBeenCalledTimes(1)
  })

  it('stays on this thread with the switch off', async () => {
    pipelineMock.mockResolvedValue(Object.assign(vi.fn().mockResolvedValue([{ label: 'NORMAL', score: 0.9 }]), { tokenizer: undefined }))
    const worker = fakeWorker({})
    const c = new OutputModerationClassifier(scanConfig, 0, false, worker)
    expect(await c.classify('text')).not.toBeNull()
    expect(worker.moderate).not.toHaveBeenCalled()
  })
})

describe('transcription in the inference worker (#869)', () => {
  it('transcribes in the worker, and never loads Whisper on this thread', async () => {
    const worker = fakeWorker({})
    expect(await transcribeAudio(wav(), 'audio/wav', 0, worker)).toBe('spoken words')
    expect(worker.transcribe).toHaveBeenCalledWith(expect.any(Float32Array))
    expect(pipelineMock).not.toHaveBeenCalled()
  })

  it('falls back to this thread when the worker is gone for good', async () => {
    pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue({ text: 'local words' }))
    const worker = fakeWorker({ transcribe: vi.fn().mockRejectedValue(new WorkerUnavailableError()) })
    expect(await transcribeAudio(wav(), 'audio/wav', 0, worker)).toBe('local words')
  })
})
