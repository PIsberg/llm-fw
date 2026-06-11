import { MediaBlock } from '../types.js'

/**
 * Non-text content handling (issue #60).
 *
 * Image / document / audio blocks ride alongside text in every provider's
 * message format and were previously invisible to the pipeline. This module
 * recovers what CAN be inspected without OCR:
 *
 *   • text-bearing mime types (text/*, JSON, XML, CSV, HTML, markdown) that
 *     arrive base64-encoded — decoded and returned as scannable text
 *   • PDFs — scanned for printable-text runs in the raw bytes. This catches
 *     uncompressed text objects, metadata, and payloads appended after %%EOF
 *     (a common smuggling spot); compressed streams stay opaque
 *   • everything else (raster images, audio, video) — surfaced as an opaque
 *     MediaBlock so the pipeline can warn (audit) or refuse (block) instead
 *     of silently passing it through
 */

/** Mime types whose payload is text and can be decoded + scanned directly. */
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|markdown|x-markdown))/i

/** Default cap on decoded bytes per block — bounds memory on hostile payloads. */
const MAX_DECODED_BYTES_DEFAULT = 2_097_152 // 2 MiB

/**
 * Extract printable-character runs from arbitrary bytes. Used for PDFs (and
 * any unknown format worth a cheap look): injection text embedded uncompressed
 * surfaces as long printable runs, while binary noise stays below the floor.
 */
export function extractPrintableRuns(buf: Buffer): string {
  const runs = buf.toString('latin1').match(/[\x20-\x7E\t]{20,}/g)
  return runs ? runs.join('\n') : ''
}

/**
 * Decode a base64 media payload into scannable text, or null when the format
 * is opaque (raster image, audio, …). `sizeHint` lets callers skip decoding
 * oversized payloads without allocating.
 */
export function decodeMediaText(mimeType: string | undefined, base64Data: string, maxBytes = MAX_DECODED_BYTES_DEFAULT): string | null {
  // base64 inflates by 4/3 — quick reject before allocating the buffer.
  if (base64Data.length > (maxBytes / 3) * 4) return null
  let buf: Buffer
  try {
    buf = Buffer.from(base64Data, 'base64')
  } catch {
    return null
  }
  if (buf.length === 0) return null

  const mime = (mimeType ?? '').split(';')[0]?.trim() ?? ''
  if (TEXT_MIME_RE.test(mime)) {
    return buf.toString('utf-8')
  }
  if (/^application\/pdf$/i.test(mime) || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    const runs = extractPrintableRuns(buf)
    return runs.length > 0 ? runs : null
  }
  return null
}

/** Parse a `data:` URL into its mime type and base64 payload (null otherwise). */
export function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (!m || !m[2]) return null // only base64 data URLs carry binary payloads
  return { mimeType: m[1] ?? 'application/octet-stream', data: m[3] ?? '' }
}

/** Build a MediaBlock from a base64 payload, decoding text where possible. */
export function mediaBlockFromBase64(kind: MediaBlock['kind'], mimeType: string | undefined, base64Data: string): MediaBlock {
  const text = decodeMediaText(mimeType, base64Data)
  return {
    kind,
    mimeType,
    sizeBytes: Math.floor(base64Data.length * 3 / 4),
    ...(text ? { text } : {}),
    // Keep the raw payload for opaque raster images so the optional OCR stage
    // can read the pixels. Text-bearing blocks are already decoded; no point
    // retaining their bytes.
    ...(!text && kind === 'image' ? { data: base64Data } : {}),
  }
}

/** One-line summary of opaque blocks for the audit event payload. */
export function summarizeOpaque(blocks: MediaBlock[]): string {
  const counts = new Map<string, number>()
  for (const b of blocks) {
    const key = b.mimeType || b.kind
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ')
}
