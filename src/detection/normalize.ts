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
  const tokens = text.split(/(\s+)/)
  const latin = (i: number): boolean => /[a-zA-Z]/.test(tokens[i] ?? '')
  const fold = (token: string): string => token.split('').map(char => homoglyphs[char] || char).join('')
  return tokens.map((token, i) => {
    if (/[a-zA-Z]/.test(token)) return fold(token)
    const letters = token.match(/\p{L}/gu)
    if (!letters || !letters.every(c => c in homoglyphs)) return token
    // tokens alternate word, whitespace, word: the neighbouring words are i ± 2.
    // At the start or end of the text the one neighbour there is has to be Latin.
    const before = i - 2 < 0 || latin(i - 2)
    const after = i + 2 >= tokens.length || latin(i + 2)
    return before && after && (latin(i - 2) || latin(i + 2)) ? fold(token) : token
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

function decodeBase64Candidates(text: string): { text: string; source: string }[] {
  const matches = text.match(/([A-Za-z0-9+/]{4,}=*)/g) || []
  const results: { text: string; source: string }[] = []
  for (const match of matches) {
    if (match.length < 8) continue
    try {
      const decoded = Buffer.from(match, 'base64').toString('utf-8')
      if (/[\p{L}\p{N}\s]{4,}/u.test(decoded) && /^[\x21-\x7E\s\u0400-\u04FF\u4E00-\u9FFF]+$/.test(decoded)) {
        results.push({ text: decoded, source: 'base64' })
      }
    } catch {}
  }
  return results
}

// A decoded blob "looks like text" if it has a run of letters/digits/space and
// is confined to printable ASCII + common scripts (Latin-1, Cyrillic, CJK). The
// same gate the base64/hex decoders use, factored out for the new decoders.
function looksLikeText(decoded: string): boolean {
  return /[\p{L}\p{N}\s]{4,}/u.test(decoded) && /^[\x21-\x7E\sЀ-ӿ一-鿿]+$/.test(decoded)
}

// RFC 4648 base32. Attackers uppercase or lowercase freely, so match both and
// fold to canonical case before decoding; the looksLikeText gate rejects the
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
      const decoded = Buffer.from(out).toString('utf-8')
      if (looksLikeText(decoded)) results.push({ text: decoded, source: 'base32' })
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
      const decoded = Buffer.from(out).toString('utf-8')
      if (looksLikeText(decoded)) results.push({ text: decoded, source: 'ascii85' })
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

  // Prevents homoglyph substitution
  result = translateHomoglyphs(result);

  result = result.normalize('NFKC');

  result = dropInvisibles(result);

  // Prevents zero-width character injection to split tokens invisibly
  result = result.replace(/[\u200B-\u200D\uFEFF\u00AD]/gu, '');

  // Strips invisible smuggling channels (Unicode Tags, bidi controls, variation
  // selectors) so a hidden payload cannot fragment tokens for the heuristic /
  // embedding stages. The raw prompt is scanned for these by detectHiddenChars()
  // BEFORE normalization, so removing them here never erases evidence.
  result = result.replace(HIDDEN_CHAR_STRIP_RE, '');

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
