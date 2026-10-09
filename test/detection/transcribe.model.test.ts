import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

// Real-model round trip for speech transcription (#82): a WAV clip of a
// synthesised voice speaking an injection goes in as an OpenAI input_audio
// part, Whisper transcribes it, and the pipeline blocks on the transcript.
//
// Opt-in, like the OCR content suite (RUN_OCR): the first run downloads the
// ~40 MB Whisper model. Run with RUN_TRANSCRIBE=1. The fixtures were produced
// with the Windows System.Speech synthesiser (16 kHz, 16-bit mono); see
// test/detection/fixtures/audio/README.md.
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/audio/${name}`, import.meta.url))).toString('base64')

const bodyWith = (wavB64: string): string => JSON.stringify({
  model: 'gpt-4o-audio-preview',
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'Please answer the question in this voice memo.' },
    { type: 'input_audio', input_audio: { data: wavB64, format: 'wav' } },
  ] }],
})

const meta = { target: 'api.openai.com', method: 'POST', path: '/v1/chat/completions' }

describe.skipIf(!process.env['RUN_TRANSCRIBE'])('speech transcription with the real model (nonText.transcribe)', () => {
  const config: Config = {
    ...DEFAULT_CONFIG,
    detection: { ...DEFAULT_CONFIG.detection, judgeEnabled: false },
    nonText: { enabled: true, mode: 'audit', transcribe: true },
  }

  it('transcribes the spoken injection', async () => {
    const { transcribeAudio } = await import('../../src/detection/transcribe.js')
    const text = await transcribeAudio(fixture('spoken-injection.wav'), 'audio/wav')
    expect(text.toLowerCase()).toMatch(/ignore all previous instructions/)
  }, 300_000)

  // #257: the same speech re-wrapped as a 16-bit big-endian AIFF, the format
  // Gemini accepts as audio/aiff. Built in memory from the WAV fixture so the
  // two formats carry identical samples.
  it('transcribes the same speech from an AIFF clip', async () => {
    const { transcribeAudio, decodeWav } = await import('../../src/detection/transcribe.js')
    const wav = decodeWav(Buffer.from(fixture('spoken-injection.wav'), 'base64'))
    if (!wav) throw new Error('fixture did not decode')
    const pcm = Buffer.alloc(wav.samples.length * 2)
    wav.samples.forEach((v, i) => pcm.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2))
    const comm = Buffer.alloc(18)
    comm.writeUInt16BE(1, 0)
    comm.writeUInt32BE(wav.samples.length, 2)
    comm.writeUInt16BE(16, 6)
    const e = Math.floor(Math.log2(wav.sampleRate))
    comm.writeUInt16BE(16383 + e, 8)
    comm.writeBigUInt64BE(BigInt(wav.sampleRate) << BigInt(63 - e), 10)
    const chunk = (id: string, b: Buffer) => {
      const h = Buffer.alloc(8)
      h.write(id, 0, 'latin1')
      h.writeUInt32BE(b.length, 4)
      return Buffer.concat([h, b])
    }
    const form = Buffer.concat([Buffer.from('AIFF', 'latin1'), chunk('COMM', comm), chunk('SSND', Buffer.concat([Buffer.alloc(8), pcm]))])
    const aiff = Buffer.concat([chunk('FORM', form)])
    const text = await transcribeAudio(aiff.toString('base64'), 'audio/aiff')
    expect(text.toLowerCase()).toMatch(/ignore all previous instructions/)
  }, 300_000)

  it('blocks a request whose audio speaks an injection', async () => {
    const pipeline = new Pipeline(config)
    await pipeline.init()
    const result = await pipeline.run('/v1/chat/completions', bodyWith(fixture('spoken-injection.wav')), meta)
    expect(result.action).toBe('block')
  }, 300_000)

  it('passes a request whose audio asks an ordinary question', async () => {
    const pipeline = new Pipeline(config)
    await pipeline.init()
    const result = await pipeline.run('/v1/chat/completions', bodyWith(fixture('spoken-benign.wav')), meta)
    expect(result.action).not.toBe('block')
  }, 300_000)
})
