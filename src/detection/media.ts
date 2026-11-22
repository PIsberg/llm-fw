import zlib from 'node:zlib'
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
 *   • PDFs — scanned for printable-text runs in the raw bytes (uncompressed
 *     text objects, metadata, payloads appended after %%EOF), plus the text
 *     operators of every content stream, inflated when it is FlateDecode.
 *     A stream it cannot read (an image, another filter, an encrypted file, a
 *     cap reached) marks the block `partial`, which the pipeline treats as
 *     opaque (#857)
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

/** What a media payload decoded to: its text, and whether part of it could not be read. */
export interface DecodedMedia {
  text: string | null
  partial: boolean
}

/** Streams read per PDF before the rest is left unread (and the block marked partial). */
const MAX_PDF_STREAMS = 4096

/**
 * Decode a base64 media payload into scannable text, or null when the format
 * is opaque (raster image, audio, …). `sizeHint` lets callers skip decoding
 * oversized payloads without allocating.
 */
export function decodeMediaText(mimeType: string | undefined, base64Data: string, maxBytes = MAX_DECODED_BYTES_DEFAULT): string | null {
  return decodeMedia(mimeType, base64Data, maxBytes).text
}

/** decodeMediaText, saying also whether any part of the payload went unread. */
export function decodeMedia(mimeType: string | undefined, base64Data: string, maxBytes = MAX_DECODED_BYTES_DEFAULT): DecodedMedia {
  // base64 inflates by 4/3 — quick reject before allocating the buffer.
  if (base64Data.length > (maxBytes / 3) * 4) return { text: null, partial: false }
  let buf: Buffer
  try {
    buf = Buffer.from(base64Data, 'base64')
  } catch {
    return { text: null, partial: false }
  }
  if (buf.length === 0) return { text: null, partial: false }

  const mime = (mimeType ?? '').split(';')[0]?.trim() ?? ''
  if (TEXT_MIME_RE.test(mime)) {
    return { text: buf.toString('utf-8'), partial: false }
  }
  if (/^application\/pdf$/i.test(mime) || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    const pdf = readPdf(buf, maxBytes)
    return { text: pdf.text.length > 0 ? pdf.text : null, partial: pdf.partial }
  }
  return { text: null, partial: false }
}

// Types whose streams hold no page text but may hold strings worth a raw
// look. Not an exemption: every decoded stream is also read as content.
const PLAIN_DICT = /\/Type\s*\/(?:ObjStm|XRef|Metadata)\b/
// Anything that makes the glyphs a page shows differ from the bytes read: an
// embedded font can draw any code as any shape, /Differences remaps codes,
// a Type3 font draws with its own procedures, and /Encrypt hides everything.
const UNREADABLE = /\/(?:Encrypt|Differences|Type3|FontFile[23]?)\b/
// The most a stream dictionary may span, looked for backwards from its stream.
const MAX_DICT_CHARS = 4096

/**
 * The text of a PDF: printable runs of its raw bytes, and the text operators
 * of each stream, inflated when it is FlateDecode (bounded by `maxBytes` in
 * all). Fail closed: `partial` is set whenever any stream is not read exactly
 * as written: an image, a filter other than one plain FlateDecode, an
 * indirect or escaped filter, decode parameters, a dictionary or line end it
 * cannot parse, corrupt data, a cap reached, unreadable strings (two-byte
 * glyph codes, control bytes), an embedded font or a re-encoding (which can
 * show other glyphs than the bytes say), or an encrypted file. Read only as
 * raw bytes, a PDF counted as inspected from its uncompressed dictionaries
 * alone, with not one word of its pages read (#857).
 */
function readPdf(buf: Buffer, maxBytes: number): { text: string; partial: boolean } {
  const s = buf.toString('latin1')
  const texts: string[] = [extractPrintableRuns(buf)]
  let partial = UNREADABLE.test(s)
  let budget = maxBytes
  // Backward dictionary scans, bounded in total so dense streams stay linear.
  let scanBudget = 2 * s.length + MAX_DICT_CHARS
  let streams = 0
  let ends = 0
  for (let at = s.indexOf('endstream'); at !== -1; at = s.indexOf('endstream', at + 9)) ends++
  let from = 0
  for (;;) {
    const at = s.indexOf('stream', from)
    if (at === -1) break
    from = at + 6
    if (s.startsWith('end', at - 3)) continue
    let dictEnd = at
    while (dictEnd > 0 && isPdfSpace(s.charCodeAt(dictEnd - 1))) dictEnd--
    if (!s.startsWith('>>', dictEnd - 2)) continue // the word, not the keyword
    if (++streams > MAX_PDF_STREAMS) { partial = true; break }
    const eol = s[at + 6] === '\r' && s[at + 7] === '\n' ? 2 : s[at + 6] === '\n' ? 1 : 0
    if (eol === 0) { partial = true; continue }
    const start = at + 6 + eol
    const end = s.indexOf('endstream', start)
    if (end === -1) { partial = true; break }
    from = end + 9
    const dictStart = streamDictStart(s, dictEnd, Math.min(MAX_DICT_CHARS, scanBudget))
    scanBudget -= Math.min(MAX_DICT_CHARS, dictEnd)
    if (dictStart === -1) { partial = true; continue }
    const dict = s.slice(dictStart, dictEnd)
    const filters = streamFilters(dict)
    if (filters === null || /\/DecodeParms\b/.test(dict) || /\/Subtype\s*\/Image\b/.test(dict)) { partial = true; continue }
    let data = buf.subarray(start, end)
    while (data.length > 0 && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) data = data.subarray(0, data.length - 1)
    let decoded: Buffer
    if (filters.length === 0) {
      decoded = data
    } else if (filters.length === 1 && (filters[0] === 'FlateDecode' || filters[0] === 'Fl') && budget > 0) {
      try {
        decoded = zlib.inflateSync(data, { maxOutputLength: budget })
      } catch {
        partial = true // corrupt, or past what is left of the budget
        continue
      }
      budget -= decoded.length
    } else {
      partial = true
      continue
    }
    const content = readContentStream(decoded.toString('latin1'))
    if (content.text) texts.push(content.text)
    if (content.unread > 0) partial = true
    if (PLAIN_DICT.test(dict)) {
      const runs = extractPrintableRuns(decoded)
      if (runs) texts.push(runs)
    }
  }
  // An endstream whose stream was not recognised is a stream not read.
  if (streams < ends) partial = true
  return { text: texts.filter(Boolean).join('\n'), partial }
}

/** A byte below 0x20 other than tab, line feed, vertical tab, form feed and carriage return. */
function hasControlBytes(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 9 || (c > 13 && c < 32)) return true
  }
  return false
}

const isPdfSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0

/**
 * Where the dictionary that ends just before `dictEnd` (after its `>>`)
 * starts: its matching `<<`, found by counting nesting backwards, or -1 when
 * none is found within `limit` characters.
 */
function streamDictStart(s: string, dictEnd: number, limit: number): number {
  let depth = 0
  const stop = Math.max(0, dictEnd - limit)
  for (let i = dictEnd - 2; i >= stop; i--) {
    if (s[i] === '>' && s[i + 1] === '>') { depth++; i--; continue }
    if (s[i] === '<' && s[i + 1] === '<' && --depth === 0) return i
  }
  return -1
}

/**
 * The filter names of a stream dictionary: [] with no /Filter, or null when
 * the value is anything but a direct name or a short array of names (an
 * indirect reference, a #-escaped name, a repeated key).
 */
function streamFilters(dict: string): string[] | null {
  const first = dict.indexOf('/Filter')
  if (first === -1) return []
  if (dict.indexOf('/Filter', first + 7) !== -1) return null
  let i = first + 7
  while (i < dict.length && isPdfSpace(dict.charCodeAt(i))) i++
  const name = (from: number): [string, number] | null => {
    let j = from + 1
    while (j < dict.length && /[A-Za-z0-9]/.test(dict[j]!)) j++
    if (j === from + 1 || dict[j] === '#') return null
    return [dict.slice(from + 1, j), j]
  }
  if (dict[i] === '/') {
    const n = name(i)
    return n ? [n[0]] : null
  }
  if (dict[i] !== '[') return null
  const close = dict.indexOf(']', i)
  if (close === -1 || close - i > 256) return null
  const names: string[] = []
  for (let j = i + 1; j < close;) {
    if (isPdfSpace(dict.charCodeAt(j))) { j++; continue }
    if (dict[j] !== '/') return null
    const n = name(j)
    if (!n) return null
    names.push(n[0])
    j = n[1]
  }
  return names
}

// Character tests by code: a regex per character made the tokenizer the
// cost of reading a PDF.
const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isNumberChar = (c: number): boolean => isDigit(c) || c === 46
const isOperatorStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 39 || c === 34 || c === 42

const PDF_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }

/**
 * The text a PDF content stream shows: the strings of its Tj, TJ, ' and "
 * operators, a TJ array's pieces joined (a kerning gap of 200 or more is a
 * space), a positioning operator a space, ET a line break. One pass, linear.
 */
export function pdfContentText(src: string): string {
  return readContentStream(src).text
}

/**
 * pdfContentText, counting also the strings it could not read: a hex string
 * of two-byte glyph codes (what most PDF writers emit for embedded fonts)
 * means letters only the font's ToUnicode map can recover, so such a page is
 * not inspected and the caller marks it partial.
 */
function readContentStream(src: string): { text: string; unread: number } {
  let unread = 0
  const lines: string[] = []
  let line = ''
  let pending = ''
  let inArray = false
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]!
    if (c === '(') {
      let depth = 1
      let out = ''
      i++
      while (i < n && depth > 0) {
        const d = src[i]!
        if (d === '\\') {
          const e = src[i + 1] ?? ''
          if (/[0-7]/.test(e)) {
            const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4))![0]
            out += String.fromCharCode(Number.parseInt(oct, 8))
            i += 1 + oct.length
          } else {
            out += PDF_ESCAPES[e] ?? (e === '\n' || e === '\r' ? '' : e)
            i += 2
          }
          continue
        }
        if (d === '(') depth++
        else if (d === ')' && --depth === 0) { i++; break }
        out += d
        i++
      }
      // Control bytes are glyph codes of a custom encoding, not text.
      if (hasControlBytes(out)) unread++
      else pending += out
      continue
    }
    if (c === '<' && src[i + 1] !== '<') {
      const close = src.indexOf('>', i + 1)
      if (close === -1) break
      const hex = src.slice(i + 1, close).replace(/[^0-9A-Fa-f]/g, '')
      const bytes = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex').toString('latin1')
      // Two-byte font codes decode to noise; keep only what reads as text.
      if (bytes.replace(/[\x20-\x7E]/g, '').length <= bytes.length / 5) pending += bytes
      else unread++
      i = close + 1
      continue
    }
    if (c === '%') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++
      continue
    }
    if (c === '[') { inArray = true; i++; continue }
    if (c === ']') { inArray = false; i++; continue }
    if (inArray && (c === '-' || (c >= '0' && c <= '9') || c === '.')) {
      let j = i + 1
      while (j < n && isNumberChar(src.charCodeAt(j))) j++
      if (Number(src.slice(i, j)) <= -200 && pending && !pending.endsWith(' ')) pending += ' '
      i = j
      continue
    }
    if (isOperatorStart(src.charCodeAt(i))) {
      let j = i + 1
      while (j < n && (isOperatorStart(src.charCodeAt(j)) || isDigit(src.charCodeAt(j)))) j++
      const op = src.slice(i, j)
      if (op === 'Tj' || op === 'TJ') line += pending
      else if (op === "'" || op === '"') line += (line ? ' ' : '') + pending
      else if (op === 'Td' || op === 'TD' || op === 'Tm' || op === 'T*') { if (line && !line.endsWith(' ')) line += ' ' }
      else if (op === 'ET' && line.trim()) { lines.push(line.trim()); line = '' }
      pending = ''
      i = j
      continue
    }
    i++
  }
  if (line.trim()) lines.push(line.trim())
  return { text: lines.join('\n'), unread }
}

/**
 * Parse a `data:` URL into its mime type and base64 payload (null otherwise).
 * RFC 2397: parameters may come before `;base64` (`;charset=utf-8`), a URL
 * without `;base64` carries percent-encoded text, and the type defaults to
 * text/plain. Both forms were dropped as unreadable (#857).
 */
export function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  if (!/^data:/i.test(url)) return null
  const comma = url.indexOf(',')
  if (comma === -1) return null
  const params = url.slice(5, comma).split(';')
  const base64 = params.length > 1 && params[params.length - 1]!.trim().toLowerCase() === 'base64'
  const mimeType = params[0]!.trim() || 'text/plain'
  const payload = url.slice(comma + 1)
  if (base64) return { mimeType, data: payload }
  let text: string
  try { text = decodeURIComponent(payload) } catch { text = payload }
  return { mimeType, data: Buffer.from(text, 'utf8').toString('base64') }
}

/** Build a MediaBlock from a base64 payload, decoding text where possible. */
export function mediaBlockFromBase64(kind: MediaBlock['kind'], mimeType: string | undefined, base64Data: string): MediaBlock {
  // Only documents and files are decoded as text. An image, audio or video
  // part is rendered by the provider as that medium whatever its bytes say, so
  // sniffing PDF magic in one would mark a clip "inspected" and let a payload
  // that starts with %PDF- past block mode.
  const decoded = kind === 'document' || kind === 'file' ? decodeMedia(mimeType, base64Data) : { text: null, partial: false }
  const text = decoded.text
  return {
    kind,
    mimeType,
    sizeBytes: Math.floor(base64Data.length * 3 / 4),
    ...(text ? { text } : {}),
    ...(decoded.partial ? { partial: true } : {}),
    // Keep the raw payload for opaque raster images and audio, so the optional
    // OCR and transcription stages can read them. Text-bearing blocks are
    // already decoded; no point retaining their bytes.
    ...(!text && (kind === 'image' || kind === 'audio') ? { data: base64Data } : {}),
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
