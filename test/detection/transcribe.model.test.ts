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
