import zlib from 'node:zlib'
import { MediaBlock } from '../types.js'
import { addObjectStream, contentFonts, indexObjects, lookupCode, objectNumberBefore, type FontMap } from './pdfFonts.js'

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
  pdf?: { pageText: string; otherText: string }
}

const NEWLINE = Buffer.from('\n')

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
    return { text: pdf.text.length > 0 ? pdf.text : null, partial: pdf.partial, pdf: { pageText: pdf.pageText, otherText: pdf.otherText } }
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
// A #xx escape spells a name another way (/Fil#74er is /Filter), so no key
// check can be trusted in a file that uses one.
const NAME_ESCAPE = /\/[^\s/<>[\]()%{}]*#[0-9A-Fa-f]{2}/
const unreadable = (text: string): boolean => UNREADABLE.test(text) || NAME_ESCAPE.test(text)
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
function readPdf(buf: Buffer, maxBytes: number): { text: string; partial: boolean; pageText: string; otherText: string } {
  const pageTexts: string[] = []
  const plainRuns: string[] = []
  const readRanges: [number, number][] = []
  const s = buf.toString('latin1')
  const texts: string[] = [extractPrintableRuns(buf)]
  let partial = unreadable(s)
  let budget = maxBytes
  // Backward dictionary scans, bounded in total so dense streams stay linear.
  let scanBudget = 2 * s.length + MAX_DICT_CHARS
  let streams = 0
  let ends = 0
  const read: { num: number; dict: string; latin: string; runs: string }[] = []
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
    // The stream ends where its direct /Length says, at an endstream: a
    // comment or a string can hold the words stream and endstream, and only
    // the length tells the stream's own bytes from them.
    if (!lengthLandsOnEnd(s, dict, start, end)) { partial = true; continue }
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
    const latin = decoded.toString('latin1')
    // Object streams hold font and encoding dictionaries too.
    if (unreadable(latin)) partial = true
    readRanges.push([start, end])
    read.push({ num: objectNumberBefore(s, dictStart), dict, latin, runs: PLAIN_DICT.test(dict) ? extractPrintableRuns(decoded) : '' })
  }
  // An endstream whose stream was not recognised is a stream not read.
  if (streams < ends) partial = true
  // Page text in two-byte glyph ids reads only through the ToUnicode map of
  // the font the page names (#889), known once every stream is decoded.
  const fonts = pageFonts(s, read)
  for (const r of read) {
    const content = readContentStream(r.latin, r.num === -1 ? undefined : fonts.get(r.num))
    if (content.text) {
      texts.push(content.text)
      pageTexts.push(content.text)
    }
    if (content.other) plainRuns.push(content.other)
    if (content.unread > 0) partial = true
    if (r.runs) {
      texts.push(r.runs)
      plainRuns.push(r.runs)
    }
  }
  const outside: Buffer[] = []
  let last = 0
  for (const [a, b] of readRanges) {
    if (a > last) outside.push(buf.subarray(last, a), NEWLINE)
    last = Math.max(last, b)
  }
  if (last < buf.length) outside.push(buf.subarray(last))
  const otherText = [extractPrintableRuns(Buffer.concat(outside)), ...plainRuns].filter(Boolean).join('\n')
  return { text: texts.filter(Boolean).join('\n'), partial, pageText: pageTexts.join('\n'), otherText }
}

/** Every decoded stream by its object number, with the fonts each content stream draws with. */
function pageFonts(s: string, read: { num: number; dict: string; latin: string }[]): Map<number, Map<string, FontMap>> {
  // Only a PDF that names a ToUnicode map has anything to resolve.
  if (!s.includes('/ToUnicode') && !read.some(r => r.latin.includes('/ToUnicode'))) return new Map()
  const objects = indexObjects(s)
  const streams = new Map<number, { dict: string; text: string }>()
  for (const r of read) {
    if (r.num === -1) continue
    streams.set(r.num, { dict: r.dict, text: r.latin })
    if (/\/Type\s*\/ObjStm\b/.test(r.dict)) addObjectStream(objects, r.dict, r.latin)
  }
  return contentFonts(objects, streams)
}

/** A byte below 0x20 other than tab, line feed, vertical tab, form feed and carriage return. */
function hasControlBytes(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 9 || (c > 13 && c < 32)) return true
  }
  return false
}

/**
 * Whether the dictionary's one direct /Length, counted from `start`, ends at
 * the endstream found at `end` (line ends between allowed). An indirect
 * length (`/Length 9 0 R`), a repeated key or none at all answers false.
 */
function lengthLandsOnEnd(s: string, dict: string, start: number, end: number): boolean {
  let key = -1
  for (let k = dict.indexOf('/Length'); k !== -1; k = dict.indexOf('/Length', k + 7)) {
    if (/[A-Za-z0-9]/.test(dict[k + 7] ?? '')) continue // /Length1, a font key
    if (key !== -1) return false
    key = k
  }
  if (key === -1) return false
  let i = key + 7
  while (i < dict.length && isPdfSpace(dict.charCodeAt(i))) i++
  const digitsFrom = i
  while (i < dict.length && isDigit(dict.charCodeAt(i))) i++
  if (i === digitsFrom || i - digitsFrom > 10) return false
  const length = Number(dict.slice(digitsFrom, i))
  // "N G R" is a reference to the length, not the length.
  let j = i
  while (j < dict.length && isPdfSpace(dict.charCodeAt(j))) j++
  const genFrom = j
  while (j < dict.length && isDigit(dict.charCodeAt(j))) j++
  if (j > genFrom) {
    while (j < dict.length && isPdfSpace(dict.charCodeAt(j))) j++
    if (dict[j] === 'R') return false
  }
  let at = start + length
  while (at < end && (s[at] === '\r' || s[at] === '\n')) at++
  return at === end
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

/** Whitespace or a PDF delimiter: where a name ends. */
const isNameEnd = (c: number): boolean => c <= 32 || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37

/**
 * A shown string's bytes read as the font's codes, through its ToUnicode
 * map. A one-byte code the map leaves out reads as itself (a simple font's
 * map often covers only its remapped codes); a two-byte one is a glyph with
 * no known letter, counted unmapped.
 */
function decodeCodes(bytes: string, font: FontMap): { text: string; unmapped: boolean } {
  let text = ''
  let unmapped = false
  for (let i = 0; i < bytes.length; i += font.width) {
    if (font.width === 2 && i + 1 >= bytes.length) { unmapped = true; break }
    const code = font.width === 2 ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1) : bytes.charCodeAt(i)
    const mapped = lookupCode(font, code)
    if (mapped !== undefined) text += mapped
    else if (font.width === 1) text += bytes[i]
    else unmapped = true
  }
  return { text, unmapped }
}

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
/** The operators of a content stream (ISO 32000-1, Annex A); any other bare word is not one. */
const CONTENT_OPERATORS = new Set(('b B b* B* BDC BI BMC BT BX c cm CS cs d d0 d1 Do DP EI EMC ET EX f F f* G g gs h i ID j J K k l m M MP n q Q re RG rg ri s S SC sc SCN scn sh T* Tc Td TD Tf TJ Tj TL Tm Tr Ts Tw Tz v w W W* y true false null').split(' '))
// Marked-content keys whose string stands for page text (a screen reader reads it).
const PAGE_TEXT_KEYS = new Set(['ActualText', 'Alt', 'E'])

/**
 * The text a content stream draws, and (#940) everything else it holds that
 * reads as text: strings no show operator draws and bare words that are not
 * operators. `text` gets the page-text policy; `other` keeps every rule, so
 * a string a stream carries but never shows is scanned as main scanned the
 * raw bytes of an uncompressed stream.
 */
function readContentStream(src: string, fonts?: Map<string, FontMap>): { text: string; unread: number; other: string } {
  let unread = 0
  let pendingRanges: [number, number][] = []
  const shown: [number, number][] = []
  const dropped: string[] = []
  // A marked-content string that stands for page text goes on the line.
  const pageString = (s: string, from: number, to: number): boolean => {
    if (!PAGE_TEXT_KEYS.has(lastName)) return false
    lastName = ''
    if (hasControlBytes(s)) { unread++; return true }
    line += (line && !line.endsWith(' ') ? ' ' : '') + s
    shown.push([from, to])
    return true
  }
  const queued = (before: number, from: number, to: number): void => { if (pending.length > before) pendingRanges.push([from, to]) }
  // The font the last Tf selected, when its resource has a ToUnicode map (#889).
  let font: FontMap | undefined
  let lastName = ''
  // Glyphs the strings since the last operator showed, and the last show
  // operator's count: a writer that places every glyph on its own (Chrome's
  // print-to-PDF: "7 0 Td <0048> Tj") shows its word spaces as glyphs, so a
  // move along the line after one glyph is no word break (#889).
  let pendingGlyphs = 0
  let lastShowGlyphs = 0
  let lastY: number | undefined
  const operands: number[] = []
  const show = (bytes: string, fallback: () => void): void => {
    if (!font) {
      const before = pending.length
      fallback()
      pendingGlyphs += pending.length - before
      return
    }
    const decoded = decodeCodes(bytes, font)
    if (decoded.unmapped) unread++
    pending += decoded.text
    // A simple font draws its one-byte codes through its encoding, and its
    // ToUnicode map can name other letters: the bytes, what a rendered page
    // shows, keep every rule too (security review).
    // Control bytes woven between the letters are dropped, not a reason to
    // skip them (security review).
    if (font.width === 1 && decoded.text !== bytes) {
      let drawn = ''
      for (let k = 0; k < bytes.length; k++) {
        const code = bytes.charCodeAt(k)
        if ((code >= 32 && code !== 127) || (code >= 9 && code <= 13)) drawn += bytes[k]
      }
      if (drawn.trim()) dropped.push(drawn)
    }
    pendingGlyphs += Math.ceil(bytes.length / font.width)
  }
  const lines: string[] = []
  let line = ''
  let pending = ''
  let inArray = false
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]!
    if (c === '(') {
      const from = i
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
      if (pageString(out, from, i)) continue
      const before = pending.length
      // Control bytes are glyph codes of a custom encoding, not text.
      show(out, () => { if (hasControlBytes(out)) unread++; else pending += out })
      queued(before, from, i)
      continue
    }
    // A dictionary opener is not a hex string: read as one, its second < made
    // every inline dictionary (marked content, inline images) unreadable text.
    if (c === '<' && src[i + 1] === '<') { i += 2; continue }
    if (c === '<') {
      const close = src.indexOf('>', i + 1)
      if (close === -1) break
      const hex = src.slice(i + 1, close).replace(/[^0-9A-Fa-f]/g, '')
      const bytes = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex').toString('latin1')
      if (pageString(bytes, i, close + 1)) { i = close + 1; continue }
      const before = pending.length
      // Two-byte font codes decode to noise; keep only what reads as text.
      show(bytes, () => { if (bytes.replace(/[\x20-\x7E]/g, '').length <= bytes.length / 5) pending += bytes; else unread++ })
      queued(before, i, close + 1)
      i = close + 1
      continue
    }
    if (c === '/') {
      // A name: the operand of Tf among others.
      let j = i + 1
      while (j < n && !isNameEnd(src.charCodeAt(j))) j++
      lastName = src.slice(i + 1, j)
      i = j
      continue
    }
    if (c === '%') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++
      continue
    }
    if (c === '[') { inArray = true; i++; continue }
    if (c === ']') { inArray = false; i++; continue }
    if (c === '-' || c === '+' || (c >= '0' && c <= '9') || c === '.') {
      let j = i + 1
      while (j < n && isNumberChar(src.charCodeAt(j))) j++
      const value = Number(src.slice(i, j))
      if (inArray) {
        if (value <= -200 && pending && !pending.endsWith(' ')) pending += ' '
      } else if (operands.length < 6) {
        operands.push(value)
      } else {
        operands.shift()
        operands.push(value)
      }
      i = j
      continue
    }
    if (isOperatorStart(src.charCodeAt(i))) {
      let j = i + 1
      while (j < n && (isOperatorStart(src.charCodeAt(j)) || isDigit(src.charCodeAt(j)))) j++
      const op = src.slice(i, j)
      if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') for (const r of pendingRanges) shown.push(r)
      else if (pending) dropped.push(pending)
      pendingRanges = []
      if (op === 'Tf') font = fonts?.get(lastName)
      else if (op === 'Tj' || op === 'TJ') { line += pending; lastShowGlyphs = pendingGlyphs }
      else if (op === "'" || op === '"') { line += (line ? ' ' : '') + pending; lastShowGlyphs = pendingGlyphs }
      else if (op === 'Td' || op === 'TD' || op === 'Tm' || op === 'T*') {
        const y = operands.length >= 2 ? operands[operands.length - 1] : undefined
        const alongLine = (op === 'Td' && y === 0) || (op === 'Tm' && operands.length === 6 && y === lastY)
        if (op === 'Tm') lastY = y
        if (!(alongLine && lastShowGlyphs === 1) && line && !line.endsWith(' ')) line += ' '
        lastShowGlyphs = 0
      }
      else if (op === 'ET' && line.trim()) { lines.push(line.trim()); line = '' }
      pending = ''
      pendingGlyphs = 0
      operands.length = 0
      i = j
      continue
    }
    i++
  }
  if (line.trim()) lines.push(line.trim())
  if (pending) dropped.push(pending)
  // Bare words that are not operators: blank what was drawn and every name,
  // then keep the words left.
  let rest = ''
  let at = 0
  for (const [a, b] of shown) { rest += src.slice(at, a) + ' '; at = b }
  rest += src.slice(at)
  const words = (rest.replace(/\/[^\s/[\]()<>{}%]*/g, ' ').match(/[A-Za-z][A-Za-z'*]+/g) ?? []).filter(w => !CONTENT_OPERATORS.has(w))
  return { text: lines.join('\n'), unread, other: [dropped.join('\n'), words.join(' ')].filter(Boolean).join('\n') }
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
    ...(decoded.pdf ? { pdfPageText: decoded.pdf.pageText, pdfOtherText: decoded.pdf.otherText } : {}),
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
