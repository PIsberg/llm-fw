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
  // contains a Latin letter.
  return text.split(/(\s+)/).map(token => {
    if (!/[a-zA-Z]/.test(token)) return token
    return token.split('').map(char => homoglyphs[char] || char).join('')
  }).join('')
}

function decodeLeetspeak(text: string): string {
  const leetMap: Record<string, string> = {
    '1': 'i', '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
    '@': 'a', '$': 's', '!': 'i'
  }
  return text.split('').map(char => leetMap[char] || char).join('')
}

function decodeBase64Candidates(text: string): { text: string; source: string }[] {
  const matches = text.match(/([A-Za-z0-9+/]{4,}=*)/g) || []
  const results: { text: string; source: string }[] = []
  for (const match of matches) {
    if (match.length < 8) continue
    try {
      const decoded = Buffer.from(match, 'base64').toString('utf-8')
      if (/[\p{L}\p{N}\s]{4,}/u.test(decoded) && /^[\x20-\x7E\s\u0400-\u04FF\u4E00-\u9FFF]+$/.test(decoded)) {
        results.push({ text: decoded, source: 'base64' })
      }
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
  let normalized = text.replace(/\*/g, '.').replace(/_/g, '-')
  const matches = normalized.match(/(?:[.\-\s/]{10,})/g) || []
  const results: { text: string; source: string }[] = []
  for (const match of matches) {
    const words = match.trim().split(/\s{3,}|\s*\/\s*/)
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

function decodeCaesarCandidates(text: string): { text: string; source: string }[] {
  const results: { text: string; source: string }[] = []
  const keywords = ['ignore', 'system', 'prompt', 'rules', 'forget', 'override', 'instruction']
  for (let shift = 1; shift < 26; shift++) {
    const shifted = text.replace(/[a-zA-Z]/g, (c) => {
      const base = c <= 'Z' ? 65 : 97
      return String.fromCharCode(((c.charCodeAt(0) - base + shift) % 26) + base)
    })
    const normalized = shifted.toLowerCase()
    if (keywords.some(kw => normalized.includes(kw))) {
      results.push({ text: shifted, source: 'caesar' })
    }
  }
  return results
}

function decodePigLatin(text: string): string[] {
  const commonClusters = [
    'str', 'scr', 'spr', 'thr',
    'pr', 'tr', 'dr', 'cr', 'gr', 'br', 'fr', 'pl', 'cl', 'fl', 'gl', 'bl', 'sl', 'sp', 'st', 'sc', 'sk', 'sm', 'sn', 'sw', 'ch', 'sh', 'th', 'wh', 'ph'
  ]
  const decodeWord = (word: string): string[] => {
    const match = word.match(/^([a-zA-Z]+)ay$/i)
    if (!match) return [word]
    const body = match[1]
    if (body.toLowerCase().endsWith('w')) {
      return [body.slice(0, -1)]
    }
    const matchCons = body.match(/([^aeiouAEIOU]+)$/)
    if (matchCons) {
      const cons = matchCons[1].toLowerCase()
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

export function normalize(text: string): string {
  // Strips diacritics / accents
  let result = text.normalize('NFD').replace(/\p{Diacritic}/gu, '')

  // Prevents homoglyph substitution
  result = translateHomoglyphs(result);

  result = result.normalize('NFKC');

  // Prevents zero-width character injection to split tokens invisibly
  result = result.replace(/[​‌‍﻿­]/g, '');

  // Strips invisible smuggling channels (Unicode Tags, bidi controls, variation
  // selectors) so a hidden payload cannot fragment tokens for the heuristic /
  // embedding stages. The raw prompt is scanned for these by detectHiddenChars()
  // BEFORE normalization, so removing them here never erases evidence.
  result = result.replace(HIDDEN_CHAR_STRIP_RE, '');

  // Prevents punctuation flooding to bypass keyword or pattern detectors
  result = result.replace(/([^\p{L}\p{N}\s])\1{2,}/gu, '$1');

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
  let result = text.normalize('NFKC')
  // Zero-width characters and invisible smuggling channels (Tags, bidi,
  // variation selectors) — never legitimate, safe to drop for any language.
  result = result.replace(/[​‌‍﻿­]/g, '')
  result = result.replace(HIDDEN_CHAR_STRIP_RE, '')
  // Collapse runs of repeated punctuation and whitespace padding.
  result = result.replace(/([^\p{L}\p{N}\s])\1{2,}/gu, '$1')
  result = result.replace(/\s+/g, ' ').trim()
  return result.toLowerCase()
}

export function extractCandidates(text: string): { text: string; source: string }[] {
  const candidates: { text: string; source: string }[] = []

  const originalNormalized = normalize(text)
  candidates.push({ text: originalNormalized, source: 'original' })

  // Diacritic/script-preserving form for the multilingual embedding stage. The
  // 'original' candidate above strips diacritics for the regex heuristics,
  // which mangles diacritic-bearing scripts (Vietnamese, Thai, Tamil, …) and
  // sinks their embedding similarity. Add the semantic form so those languages
  // reach the encoder intact. Deduped when it equals the stripped form (plain
  // ASCII English), so this is a no-op for the common case.
  const semantic = normalizeSemantic(text)
  if (semantic !== originalNormalized) {
    candidates.push({ text: semantic, source: 'semantic' })
  }

  const decodedLeet = normalize(decodeLeetspeak(text))
  if (decodedLeet !== originalNormalized) {
    candidates.push({ text: decodedLeet, source: 'leetspeak' })
  }

  const decoders = [
    decodeBase64Candidates,
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
  }

  try {
    const rot = decodeROT13(text)
    const normRot = normalize(rot)
    if (normRot !== originalNormalized && normRot.length >= 4) {
      candidates.push({ text: normRot, source: 'rot13' })
    }
  } catch {}

  try {
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

export function calculateEntropy(text: string): number {
  if (!text) return 0;
  const len = text.length;
  const freqs: Record<string, number> = {};
  for (let i = 0; i < len; i++) {
    const char = text[i];
    freqs[char] = (freqs[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in freqs) {
    const p = freqs[char] / len;
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
