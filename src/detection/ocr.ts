import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Opt-in OCR for opaque raster images (issue #60).
 *
 * Injection text rendered as PIXELS (a pasted screenshot of "ignore all
 * previous instructions", a zero-size HTML div, a hidden SVG payload) carries
 * no extractable bytes, so the rest of the pipeline is blind to it. This module
 * recovers that text with tesseract.js — a pure-WASM Tesseract port: no Python,
 * no native binary, and no network at runtime once the language data is cached.
 *
 * It is gated behind `nonText.ocr` because it is comparatively expensive
 * (~0.2–2s/image) and pulls a lazy ~12 MB core+lang download on first use. The
 * tesseract.js import is dynamic so nothing loads unless OCR is switched on.
 */

// tesseract.js is loaded lazily; its types aren't imported at module scope.
type Worker = { recognize(image: Buffer): Promise<{ data: { text: string } }>; terminate(): Promise<void> }

// Reuse a single worker across requests — creation is the costly part.
let workerPromise: Promise<Worker | null> | null = null

// Raster formats Tesseract can decode. SVG (vector) and animated/exotic
// formats are skipped — there's nothing for the rasterizer to read.
const OCR_MIME_RE = /^image\/(png|jpe?g|webp|bmp|x-bmp|pnm|x-portable-bitmap|x-portable-anymap)$/i

// Skip absurd payloads before handing them to the rasterizer. base64 inflates
// 4/3, so this bounds decoded pixels too.
const MAX_OCR_BASE64 = 16 * 1024 * 1024 // ~12 MiB decoded

/** Lang data + WASM cache lives beside the CA material, not in the cwd. */
const CACHE_DIR = join(homedir(), '.llm-fw', 'ocr-cache')

async function getWorker(): Promise<Worker | null> {
  if (!workerPromise) {
    workerPromise = (async () => {
      try {
        const { createWorker } = await import('tesseract.js')
        return (await createWorker('eng', undefined, {
          cachePath: CACHE_DIR,
          // tesseract.js logs progress to console by default — silence it.
          logger: () => {},
        })) as unknown as Worker
      } catch {
        return null // OCR unavailable (offline first run, install issue) — degrade to opaque.
      }
    })()
  }
  return workerPromise
}

/** True when this block is a raster image OCR could plausibly read. */
export function isOcrCandidate(mimeType: string | undefined): boolean {
  return OCR_MIME_RE.test((mimeType ?? '').split(';')[0]?.trim() ?? '')
}

/**
 * Recover printable text from a base64 raster image. Returns '' when OCR is
 * unavailable, the format isn't a supported raster, the payload is oversized,
 * or nothing legible is found — callers then fall back to opaque handling.
 */
export async function ocrImage(base64Data: string, mimeType: string | undefined): Promise<string> {
  if (!isOcrCandidate(mimeType)) return ''
  if (base64Data.length > MAX_OCR_BASE64) return ''
  let buf: Buffer
  try {
    buf = Buffer.from(base64Data, 'base64')
  } catch {
    return ''
  }
  if (buf.length === 0) return ''
  const worker = await getWorker()
  if (!worker) return ''
  try {
    const { data } = await worker.recognize(buf)
    return (data.text ?? '').trim()
  } catch {
    return ''
  }
}

/** Tear down the worker (tests, graceful shutdown). Safe to call when idle. */
export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return
  const worker = await workerPromise
  workerPromise = null
  if (worker) {
    try { await worker.terminate() } catch { /* already gone */ }
  }
}
