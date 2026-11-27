/**
 * Font resolution for the PDF reader (#889). Word, Chrome's print-to-PDF and
 * LaTeX show text as hex strings of two-byte glyph ids under Identity-H,
 * which only the font's /ToUnicode CMap turns back into letters. Which CMap
 * applies depends on the page: `/F1 11 Tf` names a font resource of the page
 * the content stream belongs to, and every subset font numbers its glyphs
 * from its own start, so one merged map would read pages with the wrong
 * letters.
 *
 * Everything here is bounded and linear in the file: the object index, the
 * dictionary scans, the page-tree walk and what a CMap may expand to. A PDF
 * is attacker-controlled bytes read on the thread that serves every request.
 * Nothing here decides whether a PDF was inspected whole: an embedded font
 * can draw other shapes than its map says, so the reader keeps such a PDF
 * partial whatever this module recovers.
 */

/** How a font's codes turn into text: their width in bytes and the map. */
export interface FontMap {
  width: 1 | 2
  map: Map<number, string>
  /** Wide bfrange entries kept whole, sorted by first code: [lo, hi, first destination]. */
  ranges: [number, number, string][]
}

/** Ranges wider than this stay ranges instead of being written code by code. */
const EXPAND_RANGE_MAX = 256
/** Wide ranges kept per font. */
const MAX_RANGES = 4096

/** The text a code maps to, or undefined. */
export function lookupCode(font: FontMap, code: number): string | undefined {
  const direct = font.map.get(code)
  if (direct !== undefined || font.ranges.length === 0) return direct
  // The last range starting at or before the code.
  let lo = 0
  let hi = font.ranges.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (font.ranges[mid]![0] <= code) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  const range = found === -1 ? undefined : font.ranges[found]
  return range && code <= range[1] ? utf16(incrementLast(range[2], code - range[0])) : undefined
}

/** Objects indexed per PDF before the rest are left out. */
const MAX_OBJECTS = 100_000
/** The most of an object's text a dictionary lookup reads. */
const MAX_OBJ_CHARS = 64 * 1024
/** Parents followed from a page before giving up on inheritance. */
const MAX_TREE_DEPTH = 32
/** Mappings a CMap may produce, ranges expanded, per font and per PDF. */
const MAX_CMAP_ENTRIES = 1 << 17
const MAX_CMAP_ENTRIES_PER_PDF = 1 << 20

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0
const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isDelimiter = (c: number): boolean => isSpace(c) || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37

/**
 * The object number of the `N G obj` header that ends just before `at`
 * (whitespace between), or -1.
 */
export function objectNumberBefore(s: string, at: number): number {
  let i = at
  while (i > 0 && isSpace(s.charCodeAt(i - 1))) i--
  if (!s.startsWith('obj', i - 3)) return -1
  return headerNumber(s, i - 3)
}

/** The N of an `N G obj` whose `obj` starts at `objAt`, or -1. */
function headerNumber(s: string, objAt: number): number {
  let i = objAt
  const spaces = (): boolean => {
    const from = i
    while (i > 0 && isSpace(s.charCodeAt(i - 1))) i--
    return i < from
  }
  const digits = (max: number): number => {
    const end = i
    while (i > 0 && end - i < max && isDigit(s.charCodeAt(i - 1))) i--
    return i < end && (i === 0 || !isDigit(s.charCodeAt(i - 1))) ? Number(s.slice(i, end)) : -1
  }
  if (!spaces() || digits(5) < 0 || !spaces()) return -1
  return digits(10)
}

/**
 * Every `N G obj` in the file, as the span of its text up to its endobj,
 * its stream keyword or the next object, whichever comes first. One pass:
 * the search for each end only ever moves forward.
 */
export function indexObjects(s: string): Map<number, string> {
  const headers: { num: number; start: number }[] = []
  for (let at = s.indexOf('obj'); at !== -1 && headers.length < MAX_OBJECTS; at = s.indexOf('obj', at + 3)) {
    if (s.startsWith('end', at - 3)) continue
    if (at + 3 < s.length && !isDelimiter(s.charCodeAt(at + 3))) continue
    const num = headerNumber(s, at)
    if (num >= 0) headers.push({ num, start: at + 3 })
  }
  const objects = new Map<number, string>()
  let endobj = -1
  let stream = -1
  headers.forEach((h, k) => {
    if (endobj < h.start) endobj = indexOrEnd(s, 'endobj', h.start)
    if (stream < h.start) stream = indexOrEnd(s, 'stream', h.start)
    const next = headers[k + 1]?.start ?? s.length
    const end = Math.min(endobj, stream, next, h.start + MAX_OBJ_CHARS)
    objects.set(h.num, s.slice(h.start, end).trim())
  })
  return objects
}

const indexOrEnd = (s: string, word: string, from: number): number => {
  const at = s.indexOf(word, from)
  return at === -1 ? s.length : at
}

/** The objects of a decoded /Type /ObjStm stream, added where the file has no direct one. */
export function addObjectStream(objects: Map<number, string>, dict: string, data: string): void {
  const n = Number(dictValue(dict, 'N'))
  const first = Number(dictValue(dict, 'First'))
  if (!Number.isInteger(n) || !Number.isInteger(first) || n <= 0 || first <= 0 || first > data.length) return
  const nums = data.slice(0, first).trim().split(/\s+/).map(Number)
  const count = Math.min(n, Math.floor(nums.length / 2), MAX_OBJECTS - objects.size)
  for (let k = 0; k < count; k++) {
    const num = nums[2 * k]!
    const from = first + nums[2 * k + 1]!
    const to = k + 1 < count ? first + nums[2 * k + 3]! : data.length
    if (!Number.isInteger(num) || !(from >= first && to >= from && to <= data.length)) return
    if (!objects.has(num)) objects.set(num, data.slice(from, Math.min(to, from + MAX_OBJ_CHARS)).trim())
  }
}

/**
 * Where the value that starts at or after `i` ends: a dictionary, an array
 * or a string to its balanced close, a name or a number to its delimiter, an
 * `N G R` reference as a whole. -1 when it runs off the end.
 */
function valueEnd(s: string, i: number): number {
  while (i < s.length && isSpace(s.charCodeAt(i))) i++
  if (i >= s.length) return -1
  const c = s[i]
  if (c === '<' || c === '[' || c === '(') return containerEnd(s, i)
  if (c === '/') {
    let j = i + 1
    while (j < s.length && !isDelimiter(s.charCodeAt(j))) j++
    return j
  }
  let j = i
  while (j < s.length && !isDelimiter(s.charCodeAt(j))) j++
  if (j === i) return -1
  // An "N G R" reference is one value.
  const ref = /^\s+\d{1,5}\s+R(?![^\s/<>[\]()%{}])/.exec(s.slice(j, j + 16))
  return ref ? j + ref[0].length : j
}

/** The end of the dictionary, array, literal or hex string that opens at `i`. */
function containerEnd(s: string, i: number): number {
  let depth = 0
  let j = i
  while (j < s.length) {
    const c = s[j]
    if (c === '(') {
      // A literal string, its escapes and balanced parentheses.
      let d = 1
      j++
      while (j < s.length && d > 0) {
        if (s[j] === '\\') j++
        else if (s[j] === '(') d++
        else if (s[j] === ')') d--
        j++
      }
      if (d > 0) return -1
      if (depth === 0) return j
      continue
    }
    if (c === '<' && s[j + 1] === '<') { depth++; j++ }
    else if (c === '>' && s[j + 1] === '>') { depth--; j++ }
    else if (c === '<') {
      const close = s.indexOf('>', j + 1)
      if (close === -1) return -1
      j = close
    } else if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === '%') {
      while (j < s.length && s[j] !== '\n' && s[j] !== '\r') j++
    }
    if (depth === 0) return j + 1
    j++
  }
  return -1
}

/**
 * The entries of a dictionary, its own keys only (not those of a nested
 * dictionary), in order. A malformed dictionary yields what came before the
 * fault.
 */
export function dictEntries(dict: string): [string, string][] {
  const out: [string, string][] = []
  let i = dict.indexOf('<<')
  if (i === -1) return out
  i += 2
  for (;;) {
    while (i < dict.length && isSpace(dict.charCodeAt(i))) i++
    if (i >= dict.length || dict[i] !== '/') return out
    let k = i + 1
    while (k < dict.length && !isDelimiter(dict.charCodeAt(k))) k++
    const key = dict.slice(i + 1, k)
    const end = valueEnd(dict, k)
    if (end === -1) return out
    out.push([key, dict.slice(k, end).trim()])
    i = end
  }
}

/** One entry of a dictionary, or undefined. */
export function dictValue(dict: string, key: string): string | undefined {
  return dictEntries(dict).find(([k]) => k === key)?.[1]
}

const REF = /^(\d{1,10})\s+\d{1,5}\s+R$/
const refNumber = (value: string | undefined): number => {
  const m = value === undefined ? null : REF.exec(value)
  return m ? Number(m[1]) : -1
}

/** The references an array value holds. */
const refsIn = (array: string): number[] => [...array.matchAll(/(\d{1,10})\s+\d{1,5}\s+R\b/g)].map(m => Number(m[1]))

/**
 * Parse a ToUnicode CMap: its code width from the codespace range and its
 * bfchar and bfrange entries. `budget` is shared across the PDF's fonts and
 * spent by every mapping written, ranges expanded included.
 */
export function parseCMap(text: string, budget: { left: number }): FontMap {
  const map = new Map<number, string>()
  const ranges: [number, number, string][] = []
  let width: 1 | 2 = 2
  const space = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(text)
  if (space && space[1]!.length <= 2) width = 1
  let mode: 'none' | 'char' | 'range' = 'none'
  let held: (string | string[])[] = []
  let array: string[] | null = null
  let spent = 0
  const write = (code: number, value: string): boolean => {
    if (spent >= MAX_CMAP_ENTRIES || budget.left <= 0) return false
    spent++
    budget.left--
    map.set(code, value)
    return true
  }
  for (let i = 0; i < text.length;) {
    const c = text[i]!
    if (c === '<') {
      const close = text.indexOf('>', i + 1)
      if (close === -1) break
      const hex = text.slice(i + 1, close).replace(/[^0-9A-Fa-f]/g, '')
      i = close + 1
      if (array) { array.push(hex); continue }
      held.push(hex)
    } else if (c === '[') { array = []; i++; continue }
    else if (c === ']') {
      if (array) { held.push(array) }
      array = null
      i++
    }
    else if (/[A-Za-z]/.test(c)) {
      let j = i + 1
      while (j < text.length && /[A-Za-z]/.test(text[j]!)) j++
      const word = text.slice(i, j)
      i = j
      if (word === 'beginbfchar') mode = 'char'
      else if (word === 'beginbfrange') mode = 'range'
      else if (word === 'endbfchar' || word === 'endbfrange') mode = 'none'
      held = []
      continue
    } else { i++; continue }
    if (mode === 'char' && held.length === 2) {
      const [src, dst] = held as [string, string]
      held = []
      if (typeof dst === 'string' && !write(Number.parseInt(src, 16), utf16(dst))) break
    } else if (mode === 'range' && held.length === 3) {
      const [lo, hi, dst] = held as [string, string, string | string[]]
      held = []
      const from = Number.parseInt(lo, 16)
      const to = Number.parseInt(hi, 16)
      if (Number.isNaN(from) || Number.isNaN(to) || to < from) continue
      if (!Array.isArray(dst) && to - from > EXPAND_RANGE_MAX) {
        // Kept whole: one entry, however wide (an Identity-like 0000-FFFF).
        if (ranges.length >= MAX_RANGES || spent >= MAX_CMAP_ENTRIES || budget.left <= 0) break
        spent++
        budget.left--
        ranges.push([from, to, dst])
        continue
      }
      let ok = true
      for (let code = from; code <= to && ok; code++) {
        if (Array.isArray(dst)) {
          const d = dst[code - from]
          if (d === undefined) break
          ok = write(code, utf16(d))
        } else {
          ok = write(code, utf16(incrementLast(dst, code - from)))
        }
      }
      if (!ok) break
    } else if (mode === 'none') {
      held = []
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  return { width, map, ranges }
}

/** A hex UTF-16BE destination with its last code unit advanced by n. */
function incrementLast(hex: string, n: number): string {
  if (n === 0 || hex.length < 4) return hex
  const head = hex.slice(0, -4)
  const last = (Number.parseInt(hex.slice(-4), 16) + n) & 0xffff
  return head + last.toString(16).padStart(4, '0')
}

/** Text from hex UTF-16BE. */
function utf16(hex: string): string {
  let out = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16))
  if (hex.length === 2) out += String.fromCharCode(Number.parseInt(hex, 16))
  return out
}

/**
 * For each content stream a page or a form draws, the fonts its resource
 * names stand for. `streams` holds each stream object's dictionary and
 * decoded text by object number.
 */
export function contentFonts(objects: Map<number, string>, streams: Map<number, { dict: string; text: string }>): Map<number, Map<string, FontMap>> {
  const budget = { left: MAX_CMAP_ENTRIES_PER_PDF }
  const fontCache = new Map<number, FontMap | null>()
  // Each ToUnicode stream is parsed once, however many fonts name it: parsed
  // per font, 2,000 fonts on one 400 KB stream took 10 s (security review).
  const cmapCache = new Map<number, FontMap>()
  const resourceCache = new Map<string, Map<string, FontMap>>()
  const result = new Map<number, Map<string, FontMap>>()

  const deref = (value: string | undefined): string | undefined => {
    const num = refNumber(value)
    return num === -1 ? value : (objects.get(num) ?? streams.get(num)?.dict)
  }
  const font = (num: number): FontMap | null => {
    if (fontCache.has(num)) return fontCache.get(num)!
    fontCache.set(num, null)
    const dict = objects.get(num)
    const cmapNum = dict === undefined ? -1 : refNumber(dictValue(dict, 'ToUnicode'))
    const cmap = streams.get(cmapNum)
    if (!dict || !cmap) return null
    let parsed = cmapCache.get(cmapNum)
    if (!parsed) {
      parsed = parseCMap(cmap.text, budget)
      cmapCache.set(cmapNum, parsed)
    }
    // A simple font's codes are one byte whatever its CMap's range says.
    const own: FontMap = dictValue(dict, 'Subtype') === '/Type0' ? parsed : { ...parsed, width: 1 }
    fontCache.set(num, own)
    return own
  }
  const fontsOf = (resources: string | undefined, cacheKey: string): Map<string, FontMap> => {
    const cached = resourceCache.get(cacheKey)
    if (cached) return cached
    const fonts = new Map<string, FontMap>()
    resourceCache.set(cacheKey, fonts)
    const dict = deref(resources)
    const fontDict = dict === undefined ? undefined : deref(dictValue(dict, 'Font'))
    if (fontDict === undefined) return fonts
    for (const [name, value] of dictEntries(fontDict)) {
      const f = font(refNumber(value))
      if (f) fonts.set(name, f)
    }
    return fonts
  }
  // What each page-tree node resolves to, so every node is read once: walked
  // again for every page, 3,000 pages under a 16-deep tree took 14 s
  // (security review).
  const resolved = new Map<number, [string | undefined, string]>()
  /** A page's resources, its own or the nearest ancestor's. */
  const pageResources = (num: number, dict: string): [string | undefined, string] => {
    const chain: number[] = []
    const seen = new Set<number>([num])
    let current = dict
    let owner = num
    let found: [string | undefined, string] = [undefined, 'none']
    for (let depth = 0; depth < MAX_TREE_DEPTH; depth++) {
      const known = resolved.get(owner)
      if (known) {
        found = known
        break
      }
      chain.push(owner)
      const own = dictValue(current, 'Resources')
      if (own !== undefined) {
        found = [own, refNumber(own) === -1 ? `obj:${owner}` : `ref:${refNumber(own)}`]
        break
      }
      const parent = refNumber(dictValue(current, 'Parent'))
      if (parent === -1 || seen.has(parent)) break
      seen.add(parent)
      const next = objects.get(parent)
      if (next === undefined) break
      current = next
      owner = parent
    }
    for (const node of chain) resolved.set(node, found)
    return found
  }

  for (const [num, dict] of objects) {
    if (!/\/Type\s*\/Page(?![A-Za-z])/.test(dict) || dictValue(dict, 'Type') !== '/Page') continue
    const [resources, key] = pageResources(num, dict)
    const fonts = fontsOf(resources, key)
    if (fonts.size === 0) continue
    const contents = dictValue(dict, 'Contents')
    const target = refNumber(contents)
    const list = target !== -1 && !streams.has(target) ? objects.get(target) ?? '' : contents ?? ''
    for (const stream of target !== -1 && streams.has(target) ? [target] : refsIn(list)) {
      if (streams.has(stream) && !result.has(stream)) result.set(stream, fonts)
    }
  }
  // A form XObject draws with its own resources.
  for (const [num, { dict }] of streams) {
    if (result.has(num) || dictValue(dict, 'Subtype') !== '/Form') continue
    const own = dictValue(dict, 'Resources')
    if (own === undefined) continue
    const fonts = fontsOf(own, refNumber(own) === -1 ? `form:${num}` : `ref:${refNumber(own)}`)
    if (fonts.size > 0) result.set(num, fonts)
  }
  return result
}
