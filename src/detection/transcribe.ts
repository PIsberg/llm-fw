import { join } from 'node:path'
import { getLlmFwDir } from '../config/paths.js'

/**
 * Opt-in speech transcription for audio blocks (issue #82).
 *
 * Several providers llm-fw intercepts take audio in an ordinary chat request:
 * OpenAI's gpt-4o-audio models (`input_audio` content parts) and Gemini
 * (`inlineData` with an `audio/*` mime type). Both will follow an instruction
 * SPOKEN in the clip, and until this stage the clip crossed the firewall as an
 * opaque blob: audited or refused, never read. This module recovers the words
 * with Whisper, run locally through @huggingface/transformers (already a
 * runtime dependency for the embedding stage, so nothing new is installed),
 * and the pipeline scans the transcript like any document.
 *
 * Scope, stated plainly: only uncompressed WAV/PCM is decoded. MP3, AAC, Ogg
 * and FLAC need a codec this package does not ship, so those clips stay
 * opaque and keep their audit/block handling. Transcription never marks a clip
 * as inspected either, for the same reason OCR does not: an attacker could
 * otherwise defeat block mode by adding noise speech to a clip.
 *
 * Gated behind `nonText.transcribe` because it is expensive (a ~40 MB model
 * download on first use, then roughly real-time-or-faster on a laptop CPU)
 * and the import is dynamic, so nothing loads unless it is switched on.
 */

/** Whisper is trained on 16 kHz audio; every clip is resampled to it. */
const TARGET_RATE = 16_000

/**
 * The longest stretch handed to the model. Whisper reads 30 s windows, so a
 * long clip is several forward passes; this bounds the work one request can
 * cause. Speech past the cap is not transcribed, and the clip stays counted as
 * opaque media, so block mode still refuses it.
 */
export const MAX_TRANSCRIBE_SECONDS = 120

/**
 * Clips transcribed per request. The rest stay opaque (audited, or refused in
 * block mode), so a request carrying dozens of clips cannot buy dozens of
 * transcriptions.
 */
export const MAX_TRANSCRIBE_CLIPS = 3

/** Sample rates outside this range are not real audio, and would distort the resample bound. */
const MIN_RATE = 4_000
const MAX_RATE = 384_000

/** Skip absurd payloads before decoding. base64 inflates 4/3. */
const MAX_TRANSCRIBE_BASE64 = 32 * 1024 * 1024

/** Multilingual, so a spoken injection in any language is transcribed in it. */
const MODEL = 'Xenova/whisper-tiny'

const WAV_MIME_RE = /^audio\/(?:wav|x-wav|wave|vnd\.wave)$/i

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string } | { text?: string }[]>

let transcriberPromise: Promise<Transcriber | null> | null = null

async function getTranscriber(): Promise<Transcriber | null> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers')
        // Same cache as the embedding model (see embedding.ts), so a pre-warmed
        // LLM_FW_MODEL_DIR serves both and an air-gapped host can carry it.
        env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(getLlmFwDir(), 'models')
        env.allowLocalModels = false
        return (await pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' })) as unknown as Transcriber
      } catch {
        return null // offline first run, install issue: degrade to opaque.
      }
    })()
  }
  return transcriberPromise
}

/** True when this block is audio the decoder below can read. */
export function isTranscribeCandidate(mimeType: string | undefined): boolean {
  return WAV_MIME_RE.test((mimeType ?? '').split(';')[0]?.trim() ?? '')
}

/**
 * Decode a RIFF/WAVE file to mono samples in [-1, 1]. Handles integer PCM at
 * 8 (unsigned), 16, 24 and 32 bits, 32-bit float, and WAVE_FORMAT_EXTENSIBLE
 * wrapping either. Returns null for anything else, including a truncated file
 * or an implausible sample rate. Decoding stops at `limit` (frames, or seconds
 * at the file's own rate), so a long clip is never decoded past what will be
 * transcribed.
 */
export function decodeWav(buf: Buffer, limit: { frames?: number; seconds?: number } = {}): { samples: Float32Array; sampleRate: number } | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null
  let format = 0, channels = 0, sampleRate = 0, bits = 0
  let data: Buffer | null = null
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('latin1', o, o + 4)
    const size = buf.readUInt32LE(o + 4)
    const body = o + 8
    if (body + size > buf.length && id !== 'data') return null
    if (id === 'fmt ') {
      if (size < 16) return null
      format = buf.readUInt16LE(body)
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
      // WAVE_FORMAT_EXTENSIBLE: the real format code opens the SubFormat GUID.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24)
    } else if (id === 'data') {
      // Some writers leave a streaming placeholder size; read what is there.
      data = buf.subarray(body, Math.min(buf.length, body + size))
      break
    }
    o = body + size + (size % 2)
  }
  const isPcm = format === 1 && [8, 16, 24, 32].includes(bits)
  const isFloat = format === 3 && bits === 32
  if (!data || channels < 1 || sampleRate < MIN_RATE || sampleRate > MAX_RATE || !(isPcm || isFloat)) return null

  const bytesPer = bits / 8
  const cap = Math.min(limit.frames ?? Infinity, limit.seconds !== undefined ? Math.floor(limit.seconds * sampleRate) : Infinity)
  const frames = Math.min(Math.floor(data.length / (bytesPer * channels)), cap)
  if (frames === 0) return null
  const samples = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let ch = 0; ch < channels; ch++) {
      const o = (f * channels + ch) * bytesPer
      if (isFloat) sum += data.readFloatLE(o)
      else if (bits === 8) sum += (data.readUInt8(o) - 128) / 128
      else if (bits === 16) sum += data.readInt16LE(o) / 32768
      else if (bits === 24) sum += data.readIntLE(o, 3) / 8388608
      else sum += data.readInt32LE(o) / 2147483648
    }
    samples[f] = sum / channels
  }
  return { samples, sampleRate }
}

/** Linear-interpolation resample to 16 kHz. Speech intelligibility is all that matters here. */
export function resampleTo16k(samples: Float32Array, rate: number): Float32Array {
  if (rate === TARGET_RATE) return samples
  const length = Math.floor((samples.length * TARGET_RATE) / rate)
  const out = new Float32Array(length)
  const step = rate / TARGET_RATE
  for (let i = 0; i < length; i++) {
    const pos = i * step
    const j = Math.floor(pos)
    const frac = pos - j
    const a = samples[j] ?? 0
    const b = samples[j + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

/**
 * Transcribe a base64 audio payload. Returns '' when the format is not WAV,
 * the payload is oversized or undecodable, the model is unavailable, or no
 * speech was recognised; callers then fall back to opaque handling.
 */
export async function transcribeAudio(base64Data: string, mimeType: string | undefined): Promise<string> {
  if (!isTranscribeCandidate(mimeType)) return ''
  if (base64Data.length > MAX_TRANSCRIBE_BASE64) return ''
  let decoded: ReturnType<typeof decodeWav>
  try {
    decoded = decodeWav(Buffer.from(base64Data, 'base64'), { seconds: MAX_TRANSCRIBE_SECONDS })
  } catch {
    return ''
  }
  if (!decoded) return ''
  const audio = resampleTo16k(decoded.samples, decoded.sampleRate).subarray(0, TARGET_RATE * MAX_TRANSCRIBE_SECONDS)
  const transcriber = await getTranscriber()
  if (!transcriber) return ''
  try {
    const out = await transcriber(audio, { chunk_length_s: 30, stride_length_s: 5 })
    const text = Array.isArray(out) ? out.map(o => o.text ?? '').join(' ') : (out.text ?? '')
    return text.trim()
  } catch {
    return ''
  }
}
