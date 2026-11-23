import { HIDDEN_CHAR_STRIP_RE } from './asciiSmuggling.js'

function translateHomoglyphs(text: string): string {
  const homoglyphs: Record<string, string> = {
    'а': 'a', 'в': 'b', 'с': 'c', 'е': 'e', 'н': 'h', 'і': 'i', 'к': 'k', 'м': 'm', 'о': 'o', 'р': 'p', 'ѕ': 's', 'т': 't', 'х': 'x', 'у': 'y', 'з': 'z',
    'А': 'a', 'В': 'b', 'С': 'c', 'Е': 'e', 'Н': 'h', 'І': 'i', 'К': 'k', 'М': 'm', 'О': 'o', 'Р': 'p', 'Ѕ': 's', 'Т': 't', 'Х': 'x', 'У': 'y', 'З': 'z',
    'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'h', 'ι': 'i', 'κ': 'k', 'μ': 'm', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'χ': 'x', 'υ': 'y'
  }
  // Homoglyph substitution only makes sense for MIXED-script tokens — Latin
  // words with a few lookalike Cyrillic/Greek letters spliced in to dodge a
  // keyword regex (e.g. "ignоre" with a Cyrillic о). A token written ENTIRELY
  // in Cyrillic/Greek is legitimate foreign-language text; translating it
  // char-by-char destroys it ("инструкции" → "ihctpykции") and breaks every
  // non-Latin heuristic pattern — which is exactly why Russian/Greek
  // injections were sailing through. Only translate a token that already
  // contains a Latin letter, or one made only of look-alike letters that sits
  // between two Latin words: "і" (U+0456) for the pronoun in "і will destroy"
  // has no Latin letter of its own (#557). In Cyrillic text the neighbours are
  // Cyrillic, so "на", "о" and "с" stay Russian.
  //
  // Words are runs of letters, split on anything else, not on whitespace alone
  // (#821): in `{"result":"Αγνόησε ...` the Greek word touched the Latin key
  // through punctuation, the whole run counted as one mixed-script token, and
  // folding it lost the word the override rule needs.
  const parts = text.split(/(\P{L}+)/u) // even: letter runs ('' only at the ends), odd: separators
  const latin = (i: number): boolean => i >= 0 && i < parts.length && /[a-zA-Z]/.test(parts[i]!)
  const fold = (word: string): string => word.split('').map(char => homoglyphs[char] || char).join('')
  return parts.map((part, i) => {
    if (i % 2 === 1 || part === '') return part
    if (/[a-zA-Z]/.test(part)) return fold(part)
    if (!part.split('').every(c => c in homoglyphs)) return part
    // The neighbouring words: an all-look-alike word between Latin ones, or at
    // the start or end of the text beside one, reads as Latin.
    let b = i - 2
    while (b >= 0 && parts[b] === '') b -= 2
    let a = i + 2
    while (a < parts.length && parts[a] === '') a += 2
    const before = b < 0 || latin(b)
    const after = a >= parts.length || latin(a)
    return before && after && (latin(b) || latin(a)) ? fold(part) : part
  }).join('')
}

function decodeLeetspeak(text: string): string {
  const leetMap: Record<string, string> = {
    '1': 'i', '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
    '@': 'a', '$': 's', '!': 'i'
  }
  return text.split('').map(char => leetMap[char] || char).join('')
}

// A leetspeak run between two letters: pr3v10us, pa$$word, h@ck, m41nfr4me.
const LEET_INSIDE_WORD = /[a-z][013457@$!8]+[a-z]/i
// A unified diff: git's header, or a hunk header with its line ranges.
const DIFF_HEADER_RE = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m
// Words that mix letters and digits without hiding one: hashes and hex.
const HEX_RUN = /^(?:0x)?[0-9a-f]{7,}$/i
// An email address, tested against one whitespace-delimited token at a time.
// Anchored, and neither run may cross an '@', so a token costs time linear in
// its length. The unanchored /\S+@\S+\.[a-z]{2,}/ it replaces backtracked from
// every start position: 53 s on one 200 KB token with no '@'.
const EMAIL_TOKEN = /^[^@]+@[^@]+\.[a-z]{2,}/i

/**
 * True when some word carries leetspeak between letters. Only then is the
 * leetspeak candidate worth producing: a digit elsewhere (a version, a date,
 * sha256, utf8, 10ms) decodes to noise that hides nothing, and on the first
 * request of a real agent session that noise cost 29% of the embedding
 * stage's forward passes (#289). Email addresses are left out, since every
 * `name@domain` would otherwise read as h@ck.
 */
function hasLeetWord(text: string): boolean {
  return text
    .split(/\s+/)
    .filter(token => !(token.includes('@') && EMAIL_TOKEN.test(token)))
    .join(' ')
    .split(/[^A-Za-z0-9@$!]+/)
    .some(word => LEET_INSIDE_WORD.test(word) && !HEX_RUN.test(word))
}

// base64, and base64url (- and _ for + and /, which Buffer decodes alike).
// Matched apart: one pattern for both alphabets merged `token_<payload>` into
// one misaligned match that decoded to noise, so a url-safe token counts only
// when it holds a - or _, and the standard alphabet is matched as before.
function decodeBase64Candidates(text: string): { text: string; source: string }[] {
  const urlSafe = (text.match(/[A-Za-z0-9_-]{4,}=*/g) || []).filter(m => /[-_]/.test(m))
  const matches = [...(text.match(/[A-Za-z0-9+/]{4,}=*/g) || []), ...urlSafe]
  const results: { text: string; source: string }[] = []
  for (const match of matches) {
    if (match.length < 8) continue
    try {
      const decoded = decodedText(Buffer.from(match, 'base64').toString('utf-8'))
      if (decoded) results.push({ text: decoded, source: 'base64' })
    } catch {}
  }
  return results
}

// What decoding garbage leaves: U+FFFD for bytes that are not UTF-8, control
// characters other than whitespace (tab, line feed, vertical tab, form feed,
// carriage return stay), and private-use, unassigned or surrogate code points.
const GARBAGE = /[\u{FFFD}\p{Co}\p{Cn}\p{Cs}]|[^\P{Cc}\s]/gu
// More than this share of garbage and a decoded blob is noise, not text.
const MAX_GARBAGE_SHARE = 0.1

// A decoded blob as text worth scanning, or null when it is noise. Any script
// counts: the old gate kept only printable ASCII, Cyrillic and CJK ideographs,
// so an encoded instruction in French with accents, Greek, Arabic, Hebrew,
// Hindi, Thai, kana or Hangul, or with typographic punctuation, was never
// decoded (#857). A few garbage characters are replaced with spaces rather
// than discarding the text, so one control byte inserted between the words
// of an encoded instruction cannot hide it (the old gate dropped the whole
// text for one).
function decodedText(decoded: string): string | null {
  let garbage = 0
  const clean = decoded.replace(GARBAGE, () => { garbage++; return ' ' })
  if (garbage > decoded.length * MAX_GARBAGE_SHARE) return null
  return /[\p{L}\p{N}\s]{4,}/u.test(clean) ? clean : null
}

// RFC 4648 base32. Attackers uppercase or lowercase freely, so match both and
// fold to canonical case before decoding; the decodedText gate rejects the
// many ordinary all-letter words that happen to be valid base32 alphabet runs.
function decodeBase32Candidates(text: string): { text: string; source: string }[] {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const results: { text: string; source: string }[] = []
  const matches = text.match(/\b[A-Za-z2-7]{8,}={0,6}/g) || []
  for (const match of matches) {
    const clean = match.replace(/(?<!=)=+$/, '').toUpperCase()
    if (clean.length < 8) continue
    let bits = 0, value = 0
    const out: number[] = []
    let ok = true
    for (const c of clean) {
      const idx = ALPHABET.indexOf(c)
      if (idx === -1) { ok = false; break }
      value = (value << 5) | idx
      bits += 5
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
    }
    if (!ok || out.length < 4) continue
    try {
      const decoded = decodedText(Buffer.from(out).toString('utf-8'))
      if (decoded) results.push({ text: decoded, source: 'base32' })
    } catch {}
  }
  return results
}

// Ascii85 / base85 (Adobe variant). Only decoded when wrapped in the
// unambiguous <~ … ~> delimiters — undelimited ascii85 overlaps ordinary
// printable text and would be hopelessly false-positive.
function decodeAscii85Candidates(text: string): { text: string; source: string }[] {
  const results: { text: string; source: string }[] = []
  const matches = text.match(/<~([\s\S]*?)~>/g) || []
  for (const match of matches) {
    const inner = match.slice(2, -2).replace(/\s+/g, '')
    const out: number[] = []
    let tuple = 0, count = 0
    let ok = true
    for (const ch of inner) {
      if (ch === 'z' && count === 0) { out.push(0, 0, 0, 0); continue }
      const v = ch.charCodeAt(0) - 33
      if (v < 0 || v > 84) { ok = false; break }
      tuple = tuple * 85 + v
      if (++count === 5) {
        out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff)
        tuple = 0; count = 0
      }
    }
    if (ok && count > 0) {
      for (let i = count; i < 5; i++) tuple = tuple * 85 + 84
      const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff]
      // bytes always has 4 entries and count is at most 5, so the slice is
      // exactly the loop this replaces, with the bound carried by the values.
      for (const b of bytes.slice(0, count - 1)) out.push(b)
    }
    if (!ok || out.length < 4) continue
    try {
      const decoded = decodedText(Buffer.from(out).toString('utf-8'))
      if (decoded) results.push({ text: decoded, source: 'ascii85' })
    } catch {}
  }
  return results
}

function decodeHexCandidates(text: string): { text: string; source: string }[] {
  const results: { text: string; source: string }[] = []
  const spaceSeparated = text.match(/(?:[0-9a-fA-F]{2}\s+){3,}[0-9a-fA-F]{2}/g) || []
  for (const match of spaceSeparated) {
    try {
      const bytes = match.split(/\s+/).map(x => parseInt(x, 16))
      const decoded = Buffer.from(bytes).toString('utf-8')
      if (/[\p{L}\p{N}\s]{4,}/u.test(decoded)) results.push({ text: decoded, source: 'hex' })
    } catch {}
  }
  const continuous = text.match(/[0-9a-fA-F]{8,}/g) || []
  for (const match of continuous) {
    if (match.length % 2 !== 0) continue
    try {
      const bytes: number[] = []
      for (let i = 0; i < match.length; i += 2) {
        bytes.push(parseInt(match.slice(i, i + 2), 16))
      }
      const decoded = Buffer.from(bytes).toString('utf-8')
      if (/[\p{L}\p{N}\s]{4,}/u.test(decoded)) results.push({ text: decoded, source: 'hex' })
    } catch {}
  }
  return results
}

function decodeBinaryCandidates(text: string): { text: string; source: string }[] {
  const results: { text: string; source: string }[] = []
  const matches = text.match(/(?:[01]{8}\s+){2,}[01]{8}/g) || []
  for (const match of matches) {
    try {
      const bytes = match.split(/\s+/).map(x => parseInt(x, 2))
      const decoded = Buffer.from(bytes).toString('utf-8')
      if (/[\p{L}\p{N}\s]{4,}/u.test(decoded)) results.push({ text: decoded, source: 'binary' })
    } catch {}
  }
  return results
}

const MORSE_MAP: Record<string, string> = {
  '.-': 'a', '-...': 'b', '-.-.': 'c', '-..': 'd', '.': 'e',
  '..-.': 'f', '--.': 'g', '....': 'h', '..': 'i', '.---': 'j',
  '-.-': 'k', '.-..': 'l', '--': 'm', '-.': 'n', '---': 'o',
  '.--.': 'p', '--.-': 'q', '.-.': 'r', '...': 's', '-': 't',
  '..-': 'u', '...-': 'v', '.--': 'w', '-..-': 'x', '-.--': 'y',
  '--..': 'z', '-----': '0', '.----': '1', '..---': '2',
  '...--': '3', '....-': '4', '.....': '5', '-....': '6',
  '--...': '7', '---..': '8', '----.': '9',
  '.-.-.-': '.', '--..--': ',', '..--..': '?', '.----.': "'",
  '-.-.--': '!', '-..-.': '/', '---...': ':', '-....-': '-',
  '.-.-.': '+', '-...-': '='
}

function decodeMorseCandidates(text: string): { text: string; source: string }[] {
  const normalized = text.replace(/\*/g, '.').replace(/_/g, '-')
  const matches = normalized.match(/(?:[.\-\s/]{10,})/g) || []
  const results: { text: string; source: string }[] = []
  for (const match of matches) {
    const words = match.trim().split(/\s{3,}|(?<!\s)\s*\/\s*/)
    const decodedWords: string[] = []
    for (const word of words) {
      const chars = word.trim().split(/\s+/)
      const decodedChars = chars.map(c => MORSE_MAP[c] || '').join('')
      if (decodedChars) decodedWords.push(decodedChars)
    }
    if (decodedWords.length > 0) {
      results.push({ text: decodedWords.join(' '), source: 'morse' })
    }
  }
  return results
}

function decodeROT13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}

const CAESAR_KEYWORDS = ['ignore', 'system', 'prompt', 'rules', 'forget', 'override', 'instruction']

function caesarShift(text: string, shift: number): string {
  return text.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + shift) % 26) + base)
  })
}

/**
 * Every Caesar shift of `text` that contains one of the keywords, in shift
 * order. A shift holds a keyword exactly when the lowercased text holds that
 * keyword shifted back, so the test runs on the text as it is and only the
 * shifts that match are built. It used to build all 25 shifted copies, with a
 * callback per character, to find out: 2.3 s of a 13 s scan of one 2.5 MB
 * text, on the event loop (#464).
 *
 * Lowercasing and shifting commute on ASCII letters. The two characters
 * outside ASCII that lowercase into one cannot complete a keyword: U+212A
 * becomes "k", which no keyword contains, and U+0130 becomes "i" followed by
 * U+0307, so its "i" could only end a keyword and none ends in "i". The result
 * is therefore the original's for every input (caesar-equivalence.test.ts
 * compares the two on random text that includes both characters).
 */
export function decodeCaesarCandidates(text: string): { text: string; source: string }[] {
  const results: { text: string; source: string }[] = []
  const lower = text.toLowerCase()
  for (let shift = 1; shift < 26; shift++) {
    if (CAESAR_KEYWORDS.some(kw => lower.includes(caesarShift(kw, 26 - shift)))) {
      results.push({ text: caesarShift(text, shift), source: 'caesar' })
    }
  }
  return results
}

// Common English words that end in "ay", which pig latin rarely produces.
const ENGLISH_AY_WORDS = new Set([
  'away', 'today', 'way', 'say', 'may', 'day', 'play', 'stay', 'pay', 'okay',
  'display', 'delay', 'array', 'gateway', 'relay', 'overlay', 'replay', 'anyway',
  'essay', 'yesterday', 'holiday', 'birthday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'everyday', 'midway', 'halfway',
  'pathway', 'runway', 'highway', 'railway', 'subway', 'giveaway', 'takeaway',
  'gray', 'tray', 'spray', 'pray', 'decay', 'portray', 'betray', 'dismay',
])

/**
 * Pig latin is decoded only where the text reads as pig latin: three words
 * ending in "ay" among any six consecutive words, not counting common English
 * words that end that way. Every word ending in "ay" used to produce candidates
 * (several per text, one per consonant-cluster reading), and every one was
 * embedded again: in a real agent's first request they were 116 of 317
 * embedding forward passes, more than the text itself, and the near-identical
 * copy re-matched whatever rules the plain text matched. A windowed test keeps
 * a pig-latin payload buried in a long benign document decodable.
 */
function looksLikePigLatin(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? []
  let inWindow = 0
  const flags: boolean[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const f = w.length >= 4 && w.endsWith('ay') && !ENGLISH_AY_WORDS.has(w)
    flags.push(f)
    if (f) inWindow++
    if (i >= 6 && flags[i - 6]) inWindow--
    if (inWindow >= 3) return true
  }
  return false
}

function decodePigLatin(text: string): string[] {
  const commonClusters = [
    'str', 'scr', 'spr', 'thr',
    'pr', 'tr', 'dr', 'cr', 'gr', 'br', 'fr', 'pl', 'cl', 'fl', 'gl', 'bl', 'sl', 'sp', 'st', 'sc', 'sk', 'sm', 'sn', 'sw', 'ch', 'sh', 'th', 'wh', 'ph'
  ]
  const decodeWord = (word: string): string[] => {
    const match = /^([a-z]+)ay$/i.exec(word)
    if (!match) return [word]
    // Group 1 is not optional in the pattern above, so a match always has it.
    const body = match[1]
    if (body === undefined) return [word]
    if (body.toLowerCase().endsWith('w')) {
      return [body.slice(0, -1)]
    }
    const matchCons = /(?<![^aeiouAEIOU])([^aeiouAEIOU]+)$/.exec(body)
    if (matchCons) {
      const cons = (matchCons[1] ?? '').toLowerCase()
      const decodings: string[] = []
      for (const cluster of commonClusters) {
        if (cons.endsWith(cluster)) {
          const splitIdx = body.length - cluster.length
          decodings.push(body.slice(splitIdx) + body.slice(0, splitIdx))
          break
        }
      }
      decodings.push(body.slice(-1) + body.slice(0, -1))
      if (body.length >= 2) {
        decodings.push(body.slice(-2) + body.slice(0, -2))
      }
      return Array.from(new Set(decodings))
    }
    return [body]
  }

  const words = text.split(/\s+/)
  const wordDecodings = words.map(w => decodeWord(w))
  
  const candidates: string[] = []
  for (let optionIdx = 0; optionIdx < 3; optionIdx++) {
    const sentence = wordDecodings.map(decs => decs[optionIdx] || decs[0]).join(' ')
    candidates.push(sentence)
  }
  return Array.from(new Set(candidates))
}

// #808: Python's json.dumps escapes every non-ASCII character by default
// (ensure_ascii=True), so a tool returning fetched text as JSON hands the model
// an attack in a non-Latin script as a run of backslash-u escapes, which the
// model reads as the characters and every rule read as ASCII. Decode JSON
// string escapes into a candidate of their own, never in 'original'.
//
// One left-to-right scan, as a JSON parser reads them: "\\" is one backslash,
// so an escape after an escaped backslash is still an escape, and an attacker
// who writes a backslash before every escape gains nothing. ASCII escapes are
// decoded too: an attacker picks the encoding, and a fully escaped English
// sentence reads as English to the model (security review of the first cut).
//
// The candidate holds the escaped runs alone, not the JSON around them: with a
// Latin key such as "result" beside it, normalize() reads Cyrillic or Greek
// letters as homoglyphs and folds them to Latin, and the Ukrainian attack in
// the tests passed that way. A run is escapes with the spaces, digits and
// punctuation between them; an unescaped letter ends it. The JSON quotes,
// braces and separators at either end are trimmed: they moved Stage 2 enough
// to turn a block into a warn. Sentence punctuation stays, for the same reason.
// It takes 6 escaped letters, so a source line naming a quote mark or an arrow
// is not decoded. A second candidate decodes the whole text in place, for an
// attack that escapes only some letters of each word: it is made then, or
// whenever an escaped letter touches a raw one.
const MIN_ESCAPED_LETTERS = 6
const HEX4 = /^[0-9a-fA-F]{4}$/
const LETTER = /\p{L}/u
// Whether normalize() deletes this character. Such a character between an
// escaped letter and a raw one must not count as separating them, because the
// word is joined again after the gate ran: zero-width and format characters,
// combining marks, and the backtick, caret and acute accent normalize() treats
// as diacritics (fourth and fifth security reviews). Asked of normalize() itself
// so the two cannot drift apart, but only for a character in VANISH_CANDIDATE:
// every code point normalize() deletes is in it (measured over all of them, and
// pinned by a test that walks them), and it is a few thousand characters, so
// the cache is bounded by the class rather than by a cap a text of distinct
// symbols could fill (sixth review). Whitespace never vanishes here.
const VANISH_CANDIDATE = /^[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Diacritic}\xb7\u{387}]$/u
const vanishCache = new Map<string, boolean>()
export function vanishesInNormalize(s: string): boolean {
  if (s === '') return true
  if (!VANISH_CANDIDATE.test(s)) return false
  let v = vanishCache.get(s)
  if (v === undefined) {
    v = normalize('a' + s + 'b') === 'ab'
    vanishCache.set(s, v)
  }
  return v
}
// A backslash reads as nothing: written before every escape, it leaves "\И\г\н"
// for a model to read as the word, and a rule to miss.
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', '\\': '', '/': '/', b: ' ', f: ' ', n: '\n', r: '\n', t: ' ' }
const JSON_STRUCTURE = new Set([' ', '\t', '\n', '\r', '"', '{', '}', '[', ']', ':', ','])

/** Strip JSON structure from both ends, by index: a regex anchored at the end would be quadratic. */
function trimJsonStructure(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && JSON_STRUCTURE.has(s[start]!)) start++
  while (end > start && JSON_STRUCTURE.has(s[end - 1]!)) end--
  return s.slice(start, end)
}

/** The code unit of the backslash-u escape at i, or -1 when there is none. */
function unicodeEscapeAt(text: string, i: number): number {
  if (text[i] !== '\\' || text[i + 1] !== 'u') return -1
  const hex = text.slice(i + 2, i + 6)
  return HEX4.test(hex) ? parseInt(hex, 16) : -1
}

function decodeJsonUnicodeCandidates(text: string): { text: string; source: string }[] {
  if (!text.includes('\\u')) return []
  const runs: string[] = []
  let letters = 0
  let run = ''
  let escapesInRun = 0
  // The whole text with every escape decoded in place, raw letters kept.
  let full = ''
  // An escaped letter beside a raw one: half of a word escaped, which no JSON
  // encoder writes and which leaves no run of escapes long enough to read.
  let insideWord = false
  // What the last character appended to `full` was. Decoded on the output, not
  // read from the input: an escaped backslash decodes to nothing, so wrapping
  // the escaped letter in them must not hide that it shares a word (third
  // security review).
  let last: 'raw-letter' | 'escaped-letter' | 'other' = 'other'
  const endRun = (): void => {
    if (escapesInRun > 0) {
      const trimmed = trimJsonStructure(run)
      if (trimmed !== '') runs.push(trimmed)
    }
    run = ''
    escapesInRun = 0
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') {
      const unit = unicodeEscapeAt(text, i)
      if (unit !== -1) {
        let decoded: string
        let length = 6
        const low = unit >= 0xd800 && unit <= 0xdbff ? unicodeEscapeAt(text, i + 6) : -1
        if (low >= 0xdc00 && low <= 0xdfff) {
          decoded = String.fromCharCode(unit, low)
          length = 12
        } else if (unit >= 0xd800 && unit <= 0xdfff) {
          // A lone surrogate stays as written.
          decoded = text.slice(i, i + 6)
        } else {
          // A control character reads as a space.
          decoded = unit < 0x20 ? ' ' : String.fromCharCode(unit)
        }
        if (decoded.length <= 2 && LETTER.test(decoded)) {
          letters++
          if (last === 'raw-letter') insideWord = true
          last = 'escaped-letter'
        } else if (!vanishesInNormalize(decoded)) {
          last = 'other'
        }
        run += decoded
        full += decoded
        escapesInRun++
        i += length
        continue
      }
      const simple = SIMPLE_ESCAPES[text[i + 1] ?? '']
      if (simple !== undefined) {
        run += simple
        full += simple
        if (!vanishesInNormalize(simple)) last = 'other'
        i += 2
        continue
      }
      // A stray backslash, dropped for the same reason.
      i++
      continue
    }
    // By code point, so an astral letter (a mathematical bold one, which NFKC
    // folds to Latin) counts as a letter, not as two surrogate halves.
    const chr = String.fromCodePoint(text.codePointAt(i)!)
    full += chr
    if (LETTER.test(chr)) {
      if (last === 'escaped-letter') insideWord = true
      last = 'raw-letter'
      endRun()
    } else {
      if (!vanishesInNormalize(chr)) last = 'other'
      run += chr
    }
    i += chr.length
  }
  endRun()
  const out: { text: string; source: string }[] = []
  if (letters >= MIN_ESCAPED_LETTERS) out.push({ text: runs.join('\n'), source: 'json-unicode' })
  // In place as well, when the escapes split words (second security review):
  // an attack escaping one letter per word left only fragments in the runs.
  if (insideWord || letters >= MIN_ESCAPED_LETTERS) out.push({ text: full, source: 'json-unicode-inline' })
  return out
}

function decodeUrlCandidates(text: string): { text: string; source: string }[] {
  if (!/%[0-9a-fA-F]{2}/.test(text)) return []
  try {
    const decoded = decodeURIComponent(text)
    if (decoded !== text) return [{ text: decoded, source: 'urlencoded' }]
  } catch {
    // Malformed escapes — fall back to decoding just the valid sequences.
    const partial = text.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    if (partial !== text) return [{ text: partial, source: 'urlencoded' }]
  }
  return []
}

/**
 * Collapse letter-spacing evasion: "i g n o r e   a l l" → "ignore all".
 * Runs of single-character tokens are joined into words; multi-space gaps
 * (or any multi-char token) act as word boundaries. Hyphen-spelled commands
 * ("I-G-N-O-R-E") are collapsed the same way.
 */
// Words joined by an underscore or an invisible character (#641). The rules read
// words, so "ignore_all_previous_instructions" was one token to them, and
// normalize() deletes zero-width characters, leaving one run-together word.
//
// Each run is read on its own, since normalize() flattens line breaks and a rule
// would otherwise match across unrelated identifiers: as one text, 24 of 17,309
// real texts crossed the block threshold, and alone only 5 of 3,336 distinct
// runs did, 3 of them attack strings quoted in this repository's tests.
//
// Four words for an underscore: "gandalf_ignore_instructions" is a name. Three
// for an invisible join, which no identifier has. The start only refuses a word
// character, so a word that fails here is not rescanned from each of its
// letters, and only a run of under three words ever fails.
const JOINED_WORDS_RE = /(?<![\p{L}\p{N}\p{M}])[\p{L}\p{N}\p{M}]+(?:[_\uFF3F\u200B-\u200D\u2060\uFEFF\u00AD]+[\p{L}\p{N}\p{M}]+){2,}/gu
const WORD_JOINER_RE = /[_\uFF3F\u200B-\u200D\u2060\uFEFF\u00AD]+/gu
const INVISIBLE_JOINER_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/u
const MIN_UNDERSCORE_WORDS = 4
// The same words in the other ways code joins them (#652): dots, camelCase. Ordinary
// code is full of both (11,304 distinct camelCase names and 6,055 dotted paths in
// local transcripts), so a run is read only when it names an override verb, and a
// text with no such verb skips this altogether. Three words by underscores count on
// the same terms, with the verb first: "gandalf_ignore_instructions" is a name, and
// a prefix on the verb makes four words, which are read anyway. The starts refuse a
// word character and a joiner, so a run that fails is not rescanned from inside it.
const OVERRIDE_VERB_RE = /ignore|disregard|forget|override|bypass/i
const OVERRIDE_WORD_RE = /\b(?:ignore|disregard|forget|override|bypass)\b/i
const OVERRIDE_FIRST_RE = /^(?:ignore|disregard|forget|override|bypass)\b/i
const DOTTED_WORDS_RE = /(?<![\p{L}\p{N}.])[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+){3,}(?![\p{L}\p{N}])/gu
const CAMEL_WORDS_RE = /(?<![\p{L}\p{N}_])\p{L}\p{Ll}+(?:\p{Lu}\p{Ll}+){3,}(?![\p{L}\p{N}_])/gu
const CAMEL_HUMP_RE = /(\p{Ll})(\p{Lu})/gu
// No joiner at all (#652): "ignoreallpreviousinstructions". A general word segmenter
// would split every identifier in every code file, so a run of letters is read only
// when it holds an override verb, and is split only into the words of this closed
// override vocabulary, starting at the verb. A split counts with three words or more,
// one of them a target, so "ignorecase", "ignoreallwhitespace" and
// "gandalfignoreinstructions" (two words from the verb) stay one word.
const RUN_TOGETHER_RE = /(?<![\p{L}\p{M}])[\p{L}\p{M}]{12,}/gu
const RUN_TOGETHER_VERBS = ['ignore', 'disregard', 'forget', 'override', 'bypass']
const RUN_TOGETHER_VERB_RE = /ignore|disregard|forget|override|bypass/gi
const RUN_TOGETHER_TARGETS = new Set([
  'instructions', 'instruction', 'rules', 'rule', 'prompt', 'prompts', 'directives', 'directive',
  'guidelines', 'guardrails', 'constraints', 'restrictions', 'context', 'messages', 'commands',
  'programming', 'policies', 'policy', 'filters', 'training',
])
const RUN_TOGETHER_VOCAB = new Set([
  ...RUN_TOGETHER_TARGETS, ...RUN_TOGETHER_VERBS,
  'all', 'any', 'every', 'the', 'your', 'my', 'of', 'these', 'those', 'such', 'other',
  'prior', 'previous', 'above', 'earlier', 'preceding', 'former', 'initial', 'original',
  'system', 'developer', 'safety', 'security', 'content', 'existing', 'current',
  'and', 'then', 'now', 'instead', 'from', 'before', 'that', 'this', 'you', 'were', 'are',
  'given', 'told', 'to', 'reveal', 'show', 'print', 'output', 'tell', 'me', 'say', 'do',
  'act', 'as', 'what', 'repeat', 'display', 'it', 'is', 'only', 'just', 'obey', 'follow',
])
const MAX_RUN_TOGETHER_WORD = Math.max(...[...RUN_TOGETHER_VOCAB].map(w => w.length))
const MIN_RUN_TOGETHER_WORDS = 3

/**
 * The override phrases inside one lower-cased run of letters, split into words.
 * One pass left to right: a split starts at a verb, and a position is live when a
 * vocabulary word on some split ends there. Each live position tries words at most
 * MAX_RUN_TOGETHER_WORD letters ahead, and the first split to reach a position
 * keeps it, so the work is linear in the run whatever it repeats.
 */
function runTogetherPhrases(run: string): string[] {
  const n = run.length
  const from = new Int32Array(n + 1).fill(-1) // where the word ending here starts
  const words = new Int32Array(n + 1)
  const target = new Uint8Array(n + 1)
  const start = new Int32Array(n + 1)
  const verbAt = new Uint8Array(n + 1)
  for (const m of run.matchAll(RUN_TOGETHER_VERB_RE)) verbAt[m.index] = 1
  for (let i = 0; i < n; i++) {
    const live = from[i] !== -1
    if (!live && verbAt[i] === 0) continue
    for (let j = i + 2; j <= Math.min(n, i + MAX_RUN_TOGETHER_WORD); j++) {
      if (from[j] !== -1) continue
      const word = run.slice(i, j)
      if (!RUN_TOGETHER_VOCAB.has(word)) continue
      if (!live && !RUN_TOGETHER_VERBS.includes(word)) continue
      from[j] = i
      words[j] = (live ? words[i]! : 0) + 1
      target[j] = (live ? target[i]! : 0) | (RUN_TOGETHER_TARGETS.has(word) ? 1 : 0)
      start[j] = live ? start[i]! : i
    }
  }
  // The furthest qualifying end of each split, read once.
  const furthest = new Map<number, number>()
  for (let end = 1; end <= n; end++) {
    if (from[end] !== -1 && words[end]! >= MIN_RUN_TOGETHER_WORDS && target[end] === 1) furthest.set(start[end]!, end)
  }
  const phrases: string[] = []
  for (const end of furthest.values()) {
    const parts: string[] = []
    let i = end
    while (parts.length < words[end]!) {
      const s = from[i]!
      parts.push(run.slice(s, i))
      i = s
    }
    // Walked from the end; one reverse keeps the rebuild linear in the words.
    parts.reverse()
    phrases.push(parts.join(' '))
  }
  return phrases
}
// Real texts carry 23 such runs at p99 and 266 at most, at about 0.3 ms each. An
// attacker can send thousands, so past this they share candidates: nothing goes
// unread, and the cost is bounded by the text's length rather than its runs.
const MAX_JOINED_CANDIDATES = 64

/**
 * The distinct runs of joined words, with spaces for their joiners, and nothing
 * else: a copy of a whole code file would read every other word a second time.
 * Added after the decoders, not among them, since leetspeak-decoding each
 * identifier would double the work for nothing a rule reads.
 */
function joinedWordsCandidates(text: string): { text: string; source: string }[] {
  const runs = new Set<string>()
  for (const run of new Set(text.match(JOINED_WORDS_RE))) {
    const spaced = run.replace(WORD_JOINER_RE, ' ')
    if (INVISIBLE_JOINER_RE.test(run) || spaced.split(' ').length >= MIN_UNDERSCORE_WORDS || OVERRIDE_FIRST_RE.test(spaced)) runs.add(spaced)
  }
  if (OVERRIDE_VERB_RE.test(text)) {
    for (const run of new Set(text.match(DOTTED_WORDS_RE))) {
      const spaced = run.replaceAll('.', ' ')
      if (OVERRIDE_WORD_RE.test(spaced)) runs.add(spaced)
    }
    for (const run of new Set(text.match(CAMEL_WORDS_RE))) {
      const spaced = run.replace(CAMEL_HUMP_RE, '$1 $2')
      if (OVERRIDE_WORD_RE.test(spaced)) runs.add(spaced)
    }
    for (const run of new Set(text.match(RUN_TOGETHER_RE))) {
      if (!OVERRIDE_VERB_RE.test(run)) continue
      for (const phrase of runTogetherPhrases(run.toLowerCase())) runs.add(phrase)
    }
  }
  if (runs.size === 0) return []
  return joinedCandidates([...runs])
}

function joinedCandidates(runs: string[]): { text: string; source: string }[] {
  const perCandidate = Math.ceil(runs.length / MAX_JOINED_CANDIDATES)
  const candidates: { text: string; source: string }[] = []
  for (let i = 0; i < runs.length; i += perCandidate) {
    candidates.push({ text: normalize(runs.slice(i, i + perCandidate).join(' . ')), source: 'joined-words' })
  }
  return candidates
}

function decodeSpacedCandidates(text: string): { text: string; source: string }[] {
  const results: { text: string; source: string }[] = []

  const tokens = text.split(/[^\S\r\n]+/).filter(t => t.length > 0)
  const singles = tokens.filter(t => t.length === 1 && /[\p{L}\p{N}]/u.test(t))
  if (tokens.length >= 10 && singles.length / tokens.length > 0.6) {
    const despaced = text
      .split(/\s{2,}|\n/)
      .map(group => group.split(/\s+/).map(t => (t.length === 1 ? t : ` ${t} `)).join(''))
      .join(' ')
    results.push({ text: despaced, source: 'spaced' })
  }

  if (/(?:\p{L}-){3,}\p{L}/u.test(text)) {
    results.push({ text: text.replace(/(\p{L})-(?=\p{L}\b)/gu, '$1'), source: 'hyphen-spelled' })
  }

  return results
}

function decodeReversedCandidates(text: string): { text: string; source: string }[] {
  const results: { text: string; source: string }[] = []
  const reversedAll = text.split('').reverse().join('')
  results.push({ text: reversedAll, source: 'reversed-full' })

  const reversedWords = text.split(/\s+/).map(w => w.split('').reverse().join('')).join(' ')
  results.push({ text: reversedWords, source: 'reversed-words' })

  return results
}

// A typographic apostrophe, the right or left single quotation mark. Smart
// punctuation is the keyboard and word processor default, so text pasted
// from a document carries one, and the rules spell an ASCII one (#795). The
// modifier letter apostrophe (U+02BC) is not here: it is a diacritic, so the
// strip at the top of normalize() already removes it, as it does from the
// Ukrainian words that use it as a letter.
const TYPOGRAPHIC_APOSTROPHE_RE = /[\u2018\u2019]/g

/**
 * The rules' view of a text: U+2018 and U+2019 read as an ASCII apostrophe.
 * Stage 1 folds its normalized text (#795); the indirect-instruction,
 * harmful-request and self-reference checks fold the text they read (#802).
 * Not part of normalize(), because the embedding stage
 * reads the 'original' candidate normalize() makes, and its gate was
 * calibrated on text as typed: folding there moved 246 eval similarities and
 * pushed a benign row over it. Every typographic quote a rule spells sits in
 * a class beside an ASCII one, so folding adds matches and never removes one.
 */
export function foldApostrophes(text: string): string {
  return text.replace(TYPOGRAPHIC_APOSTROPHE_RE, "'")
}

// Hangul fillers render blank and are used as word gaps, so they become a
// space rather than vanishing (which would glue the words together).
const HANGUL_FILLER_RE = /[ᅟᅠㅤﾠ]/g
// Every other character Unicode marks default-ignorable (rendered as nothing:
// the combining grapheme joiner, LRM/RLM, Mongolian variation selectors, the
// Arabic letter mark, and the ranges HIDDEN_CHAR_STRIP_RE already names), plus
// the interlinear annotation anchors, which are format characters.
const DEFAULT_IGNORABLE_RE = /[\p{Default_Ignorable_Code_Point}\u{FFF9}-\u{FFFB}]/gu

/**
 * Characters a model reads past, removed so they cannot split an injection
 * into pieces no pattern matches. Probed as tool output: U+034F between the
 * letters, U+3164 between the words or U+FFF9/U+FFFB around them each let an
 * otherwise refused injection through.
 */
function dropInvisibles(text: string): string {
  return text.replace(HANGUL_FILLER_RE, ' ').replace(DEFAULT_IGNORABLE_RE, '')
}

export function normalize(text: string): string {
  // Strips diacritics / accents
  let result = text.normalize('NFD').replace(/\p{Diacritic}/gu, '')

  result = result.normalize('NFKC');

  result = dropInvisibles(result);

  // Prevents zero-width character injection to split tokens invisibly
  result = result.replace(/[\u200B-\u200D\uFEFF\u00AD]/gu, '');

  // Strips invisible smuggling channels (Unicode Tags, bidi controls, variation
  // selectors) so a hidden payload cannot fragment tokens for the heuristic /
  // embedding stages. The raw prompt is scanned for these by detectHiddenChars()
  // BEFORE normalization, so removing them here never erases evidence.
  result = result.replace(HIDDEN_CHAR_STRIP_RE, '');

  // Prevents homoglyph substitution. On the text the rules read: after NFKC and
  // the invisible strips, so neither a zero-width character nor a letter NFKC
  // turns Latin (a circled t) splits a look-alike word for the fold (security
  // review of #821).
  result = translateHomoglyphs(result);

  // A markdown bullet (one dash at a line start, then a space) is layout. The
  // flood collapse below turns "---" into "-", after which "- Stop at the
  // publish step" (a CLAUDE.md Claude Code sends in every session) read the
  // same as a "--- stop" delimiter (#395). Dropping the lone marker first
  // leaves only a run of two or more dashes to reach the delimiter rule.
  result = result.replace(/^([ \t]*)-(?=[ \t]+\S)/gm, '$1');

  // Prevents punctuation flooding to bypass keyword or pattern detectors
  result = result.replace(/([^\p{L}\p{N}\s])\1{2,}/gu, '$1');

  // A unified diff's line markers are layout, not text: flattened with the
  // newlines below, "run lat check\n+  uses: ..." read as "run x + y", which is
  // payload assembly (20 of 27 such blocks replaying real tool results were
  // diffs of CI files and code). Only text that carries a diff header loses
  // them, one marker per line; an inline "+" is untouched.
  if (DIFF_HEADER_RE.test(result)) result = result.replace(/^[+-]/gm, '');

  // Prevents whitespace padding / splitting tricks to fragment tokens
  result = result.replace(/\s+/g, ' ').trim();

  // Prevents case variation used to evade case-sensitive pattern matching
  result = result.toLowerCase();

  return result;
}

/**
 * Lighter normalization for the SEMANTIC (embedding) stage.
 *
 * normalize() above is built for the regex heuristics: it strips diacritics and
 * folds homoglyphs to defeat evasion. But that destroys legitimate text in
 * diacritic-bearing scripts — Vietnamese "Bỏ qua" collapses to "Bo qua", and
 * Thai/Tamil/Devanagari vowel signs are \p{Diacritic} too, so whole sentences
 * are mangled before the multilingual encoder sees them, sinking their
 * similarity and letting those languages pass. The embedding model was trained
 * on natural text WITH diacritics, so the semantic stage keeps the script
 * intact and only removes the invisible smuggling channels + obvious padding.
 */
export function normalizeSemantic(text: string): string {
  let result = dropInvisibles(text.normalize('NFKC'))
  // Zero-width characters and invisible smuggling channels (Tags, bidi,
  // variation selectors) — never legitimate, safe to drop for any language.
  result = result.replace(/[\u200B-\u200D\uFEFF\u00AD]/gu, '')
  result = result.replace(HIDDEN_CHAR_STRIP_RE, '')
  // Collapse runs of repeated punctuation and whitespace padding.
  result = result.replace(/([^\p{L}\p{N}\s])\1{2,}/gu, '$1')
  result = result.replace(/\s+/g, ' ').trim()
  return result.toLowerCase()
}

const NON_ASCII_LETTER_RE = /(?![A-Za-z])\p{L}/u
const wordsOf = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * The candidate list, built one step at a time: each `yield` follows a step
 * that reads the whole text. extractCandidates runs it straight through;
 * extractCandidatesYielding hands the event loop back at each yield, so one
 * large text no longer holds every other request for the whole of it (#464).
 * Both return the same list.
 */
function* candidateSteps(text: string): Generator<void, { text: string; source: string }[], undefined> {
  const candidates: { text: string; source: string }[] = []

  const originalNormalized = normalize(text)
  candidates.push({ text: originalNormalized, source: 'original' })
  yield

  // Diacritic/script-preserving form for the multilingual embedding stage. The
  // 'original' candidate above strips diacritics for the regex heuristics,
  // which mangles diacritic-bearing scripts (Vietnamese, Thai, Tamil, …) and
  // sinks their embedding similarity. Add the semantic form so those languages
  // reach the encoder intact. Skipped only when it differs from 'original' by
  // punctuation alone (a backtick in 2,132 of 2,380 real Claude Code items
  // that produced one), which costs a second embedding pass per chunk for
  // nothing (#297). It is kept whenever the two forms split into different
  // words: normalize() deletes `, ^ and the middle dot outright (they count as
  // diacritics), so "ignore`all`previous`instructions" reaches 'original' as
  // one run-together token and only the semantic copy keeps the words apart
  // (security review of the first cut).
  const semantic = normalizeSemantic(text)
  if (semantic !== originalNormalized && (NON_ASCII_LETTER_RE.test(semantic) || wordsOf(semantic) !== wordsOf(originalNormalized))) {
    candidates.push({ text: semantic, source: 'semantic' })
  }
  yield

  // Decoded across the whole text, as before, once any word carries
  // leetspeak: '4ll' and '4nd' only decode because pr3v10us beside them did.
  if (hasLeetWord(text)) {
    const decodedLeet = normalize(decodeLeetspeak(text))
    if (decodedLeet !== originalNormalized) {
      candidates.push({ text: decodedLeet, source: 'leetspeak' })
    }
    yield
  }

  const decoders = [
    decodeBase64Candidates,
    decodeBase32Candidates,
    decodeAscii85Candidates,
    decodeHexCandidates,
    decodeBinaryCandidates,
    decodeMorseCandidates,
    decodeCaesarCandidates,
    decodeReversedCandidates,
    decodeUrlCandidates,
    decodeSpacedCandidates
  ]

  for (const decoder of decoders) {
    try {
      const decodedList = decoder(text)
      for (const item of decodedList) {
        const norm = normalize(item.text)
        if (norm.length >= 4) {
          candidates.push({ text: norm, source: item.source })
          const leetNorm = normalize(decodeLeetspeak(item.text))
          if (leetNorm !== norm && leetNorm.length >= 4) {
            candidates.push({ text: leetNorm, source: `${item.source}-leetspeak` })
          }
        }
      }
    } catch {}
    yield
  }

  // #808: decoded escapes in both forms the plain text gets. The
  // diacritic-stripped form alone left an escaped Greek or Chinese attack that
  // blocks as plain text at a Stage 2 warn: the plain text blocks on its
  // 'semantic' candidate.
  for (const item of decodeJsonUnicodeCandidates(text)) {
    const norm = normalize(item.text)
    if (norm.length < 4) continue
    candidates.push({ text: norm, source: item.source })
    const semanticForm = normalizeSemantic(item.text)
    if (semanticForm !== norm) candidates.push({ text: semanticForm, source: `${item.source}-semantic` })
  }
  yield

  try {
    const rot = decodeROT13(text)
    const normRot = normalize(rot)
    if (normRot !== originalNormalized && normRot.length >= 4) {
      candidates.push({ text: normRot, source: 'rot13' })
    }
  } catch {}
  yield

  if (looksLikePigLatin(text)) try {
    const plList = decodePigLatin(text)
    for (const pl of plList) {
      const normPl = normalize(pl)
      if (normPl !== originalNormalized && normPl.length >= 4) {
        candidates.push({ text: normPl, source: 'piglatin' })
      }
    }
  } catch {}

  candidates.push(...joinedWordsCandidates(text))
  yield

  const seen = new Set<string>()
  const uniqueCandidates: { text: string; source: string }[] = []
  for (const cand of candidates) {
    if (!seen.has(cand.text)) {
      seen.add(cand.text)
      uniqueCandidates.push(cand)
    }
  }

  return uniqueCandidates;
}

export function extractCandidates(text: string): { text: string; source: string }[] {
  const steps = candidateSteps(text)
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

/** Texts at least this long hand the event loop back between scan steps. */
export const YIELD_ABOVE_CHARS = 64 * 1024

/** Resolves on the next turn of the event loop, after pending I/O callbacks. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * extractCandidates, handing the event loop back after each step that reads
 * the whole text when the text is at least YIELD_ABOVE_CHARS long (#464).
 * Same list as extractCandidates; shorter texts run straight through.
 */
export async function extractCandidatesYielding(text: string): Promise<{ text: string; source: string }[]> {
  if (text.length < YIELD_ABOVE_CHARS) return extractCandidates(text)
  const steps = candidateSteps(text)
  let step = steps.next()
  while (!step.done) {
    await yieldToEventLoop()
    step = steps.next()
  }
  return step.value
}

export function calculateEntropy(text: string): number {
  if (!text) return 0;
  const len = text.length;
  const freqs: Record<string, number> = {};
  // Iterating the string yields the characters themselves, so neither the
  // index nor the lookup needs a guard the loop already provides.
  for (const char of text) {
    freqs[char] = (freqs[char] ?? 0) + 1;
  }
  let entropy = 0;
  for (const char in freqs) {
    const p = (freqs[char] ?? 0) / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Maximum Shannon entropy over a sliding window of the text.
 *
 * A small, highly obfuscated payload (e.g. a 60-char base64 blob) embedded in a
 * large benign prompt barely moves the entropy of the WHOLE string, so a global
 * entropy gate is diluted below threshold and misses it. Scanning fixed-size
 * windows and taking the maximum surfaces the dense pocket of randomness
 * regardless of how much benign text surrounds it.
 */
export function maxWindowEntropy(text: string, windowSize = 64, step = 32): number {
  if (!text) return 0;
  if (text.length <= windowSize) return calculateEntropy(text);
  let max = 0;
  for (let i = 0; i + windowSize <= text.length; i += step) {
    const e = calculateEntropy(text.slice(i, i + windowSize));
    if (e > max) max = e;
  }
  // A fixed step can skip the final window; include it explicitly.
  const tail = calculateEntropy(text.slice(text.length - windowSize));
  if (tail > max) max = tail;
  return max;
}
