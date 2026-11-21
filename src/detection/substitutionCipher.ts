// Multi-turn word-substitution cipher (#833).
//
// The attack spreads a request over turns: each early user turn defines one
// pair ("<word> - <code word>"), and the last turn asks in code words, so no
// single turn reads as the request it is and the per-turn stages pass it. The
// tom-gibbs multi-turn jailbreak set is built this way (#540's
// `multiturn-cipher` split, held out). This decodes the last user turn with
// the pairs the conversation defined, in both directions, so a caller can run
// the decoded text through a detector that reads requests.
//
// A pair counts only in a user turn that holds nothing but pairs (and short
// "Label:" lines), so a glossary pasted into a question is not a cipher, and
// it takes MIN_PAIRS of them. Every scan is linear: lines are parsed only up to
// MAX_PAIR_LINE characters, decoding is one pass over the last turn's words
// with a map lookup per word, whatever the number of pairs, and it adds at most
// MAX_DECODE_GROWTH characters.

import type { ConversationTurn } from '../types.js'

/** Fewer pairs than this are a glossary or a nickname, not a cipher. */
export const MIN_PAIRS = 3

/** A pair line is short; anything longer is prose and is not parsed. */
const MAX_PAIR_LINE = 100

/**
 * The most decoding may add to the last turn, in characters. A one-letter code
 * word can stand for a side of 60, so without a bound a long last turn decodes
 * into many times its size, which the harmful-request scan then reads.
 */
export const MAX_DECODE_GROWTH = 65_536

/** A side of a pair is at most this many words. */
const MAX_SIDE_WORDS = 4

const PAIR = /^(.{1,60}?)(?:\s*[:=]\s+|\s+(?:-|–|—|->|→|=>|means|stands for|is code for)\s+)(.{1,60})$/iu
const LABEL = /^[^\n]{1,40}:$/u
const WORD = /[\p{L}\p{N}]+/gu
const GAP = /^\s+$/u

export interface SubstitutionDecode {
  /** Pairs the conversation defined. */
  pairs: number
  /** The last user turn decoded each way round, where that changed it. */
  decoded: string[]
}

const words = (s: string): string[] => s.match(WORD) ?? []

function parsePair(line: string): [string[], string[]] | null {
  if (line.length > MAX_PAIR_LINE) return null
  const m = PAIR.exec(line)
  if (!m) return null
  const left = words(m[1] ?? '')
  const right = words(m[2] ?? '')
  if (left.length === 0 || right.length === 0 || left.length > MAX_SIDE_WORDS || right.length > MAX_SIDE_WORDS) return null
  return [left, right]
}

/** The pairs of a turn that holds only pairs and labels, or null. */
function pairTurn(text: string): Array<[string[], string[]]> | null {
  const out: Array<[string[], string[]]> = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const pair = parsePair(line)
    if (pair) { out.push(pair); continue }
    if (line.length <= MAX_PAIR_LINE && LABEL.test(line)) continue
    return null
  }
  return out.length > 0 ? out : null
}

const key = (ws: readonly string[]): string => ws.join(' ').toLowerCase()

/**
 * Replace every whole-word run of a map key in `text`, longest key first at
 * each word, keys of up to MAX_SIDE_WORDS words separated by whitespace only.
 * Once the replacements have added MAX_DECODE_GROWTH characters, the rest is
 * copied as it is.
 */
function substitute(text: string, map: ReadonlyMap<string, string>): string {
  const spans: Array<{ word: string; start: number; end: number }> = []
  for (const m of text.matchAll(WORD)) spans.push({ word: m[0], start: m.index, end: m.index + m[0].length })
  let out = ''
  let pos = 0
  let growth = 0
  for (let i = 0; i < spans.length;) {
    let hit: { n: number; to: string } | null = null
    for (let n = Math.min(MAX_SIDE_WORDS, spans.length - i); n >= 1 && !hit; n--) {
      let joined = true
      for (let j = i; j < i + n - 1; j++) {
        if (!GAP.test(text.slice(spans[j]!.end, spans[j + 1]!.start))) { joined = false; break }
      }
      if (!joined) continue
      const to = map.get(key(spans.slice(i, i + n).map(s => s.word)))
      if (to !== undefined) hit = { n, to }
    }
    const added = hit ? hit.to.length - (spans[i + hit.n - 1]!.end - spans[i]!.start) : 0
    if (hit && growth + added <= MAX_DECODE_GROWTH) {
      growth += added
      out += text.slice(pos, spans[i]!.start) + hit.to
      pos = spans[i + hit.n - 1]!.end
      i += hit.n
    } else {
      i++
    }
  }
  return out + text.slice(pos)
}

/**
 * Decode the last user turn with the pairs the earlier user turns defined, or
 * null when the conversation is no cipher (fewer than MIN_PAIRS pairs, or no
 * user turn after them).
 */
export function decodeSubstitutionCipher(conversation: readonly ConversationTurn[]): SubstitutionDecode | null {
  const user = conversation.filter(t => t.role === 'user')
  const last = user.at(-1)
  if (!last || user.length < 2 || pairTurn(last.text)) return null
  const pairs: Array<[string[], string[]]> = []
  for (const turn of user.slice(0, -1)) pairs.push(...(pairTurn(turn.text) ?? []))
  if (pairs.length < MIN_PAIRS) return null
  const decoded: string[] = []
  for (const [from, to] of [[1, 0], [0, 1]] as const) {
    const map = new Map<string, string>()
    for (const p of pairs) map.set(key(p[from]), p[to].join(' '))
    const text = substitute(last.text, map)
    if (text !== last.text) decoded.push(text)
  }
  return decoded.length > 0 ? { pairs: pairs.length, decoded } : null
}
