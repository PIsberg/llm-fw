/**
 * The windows a sequence classifier reads of a long text (#858, #898).
 *
 * Both classifiers (Stage 2.5's DeBERTa and the response moderation model)
 * read 512 tokens. They were given the first 4,000 characters of a text, so
 * a payload placed after some filler passed (#858); then up to four windows
 * of 2,000 characters. That was still too long: measured against the real
 * DeBERTa tokenizer on 1,502 local tool results, text runs 0.33 tokens per
 * character at the median (0.26 to 0.42 from p5 to p95), so 1,464 of those
 * 2,000-character windows ran past 512 tokens and the model never read their
 * end, the last few hundred characters of the text included (#898).
 *
 * Windows are now laid out by an estimate of the tokenizer's count
 * (tokenPrefix: against the real tokenizer, 0.89 / 1.00 / 1.09 of its
 * count at p5 / median / p95 on those tool results, 1.03 / 1.08 / 1.13 on
 * Dolly prose, 0.94 on base64, exact on CJK), WINDOW_TOKENS each, a budget
 * the p5 estimate keeps under 512 real tokens, so the model reads each
 * window whole: the first at the start, the last at the
 * end, and up to MAX_CLASSIFIER_WINDOWS evenly between. Past what those
 * cover, the stretches between them were fixed by the text's length (#898),
 * so up to MAX_MARKER_WINDOWS more are placed where the uncovered text holds
 * the most instruction-like markers (an override word, an imperative, a tag,
 * a URL). Still deterministic, so one text always gets one verdict, which the
 * score cache, suppression marks and the benchmark gates rely on. The
 * heuristic stage reads every byte and the embedding stage samples the
 * whole text either way.
 */
export const WINDOW_TOKENS = 440
export const MAX_CLASSIFIER_WINDOWS = 4
export const MAX_MARKER_WINDOWS = 2


const isSpace = (c: number): boolean => c === 32 || c === 10 || c === 13 || c === 9
/** 1 a digit, 2 an upper-case letter, 3 a lower-case or other letter, 0 anything else. */
function charKind(c: number): number {
  if (c >= 48 && c <= 57) return 1
  if (c >= 65 && c <= 90) return 2
  if ((c >= 97 && c <= 122) || (c >= 0xc0 && c < 0x2e80 && c !== 0xd7 && c !== 0xf7)) return 3
  return 0
}

/**
 * prefix[i] is the estimated token count of text.slice(0, i), never
 * decreasing. A run of letters and digits is one token, plus one per change
 * between digits, upper and lower case (a capital opening a word excepted),
 * plus one per 8 characters, or per 4 past 16 (base64, hashes); punctuation
 * and symbols one each, and so is every CJK or other character past U+2E80;
 * whitespace none.
 */
function tokenPrefix(text: string): Uint32Array {
  const prefix = new Uint32Array(text.length + 1)
  let before = 0 // tokens before the current run
  let run = 0
  let trans = 0
  let prev = 0
  let last = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const kind = charKind(c)
    let now: number
    if (kind) {
      if (run && kind !== prev && !(prev === 2 && kind === 3)) trans++
      run++
      prev = kind
      now = before + 1 + trans + Math.floor(run / (run > 16 ? 4 : 8))
    } else {
      if (run) { before = last; run = 0; trans = 0 }
      if (!isSpace(c)) before += 1
      now = before
    }
    last = Math.max(last, now)
    prefix[i + 1] = last
  }
  return prefix
}

/** The first index whose prefix count is at least `tokens`. */
function indexAt(prefix: Uint32Array, tokens: number): number {
  let lo = 0
  let hi = prefix.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((prefix[mid] ?? 0) < tokens) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The window of at most WINDOW_TOKENS that starts at `start`, as [start, end). */
function windowFrom(prefix: Uint32Array, start: number): [number, number] {
  const limit = (prefix[start] ?? 0) + WINDOW_TOKENS
  // The last index whose prefix is within the budget.
  let end = indexAt(prefix, limit + 1) - 1
  if (end <= start) end = Math.min(prefix.length - 1, start + 1)
  return [start, end]
}

// Words and shapes injected instructions are made of. Only where they are
// dense counts, and only in text no window reads yet.
const MARKER_RE = /\b(?:ignore|disregard|forget|override|bypass|instructions?|prompt|developer|assistant|must|should|never|always|please|immediately|important|urgent|secret|password|credentials?|token|keys?|exfiltrate|send|forward|upload|curl|wget|execute|run)\b|<\/?[a-z][\w-]{0,30}>|\[\/?(?:inst|system)\]|https?:\/\//gi
const MAX_MARKERS = 20_000

export function classifierWindows(text: string): string[] {
  if (text.length <= 64) return [text]
  const prefix = tokenPrefix(text)
  const total = prefix[text.length] ?? 0
  if (total <= WINDOW_TOKENS) return [text]

  const count = Math.min(MAX_CLASSIFIER_WINDOWS, Math.ceil(total / WINDOW_TOKENS))
  const spans: [number, number][] = []
  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      // The last window ends at the end of the text.
      const start = indexAt(prefix, Math.max(0, total - WINDOW_TOKENS))
      spans.push([start, text.length])
      continue
    }
    const at = Math.round((i * Math.max(0, total - WINDOW_TOKENS)) / (count - 1))
    spans.push(windowFrom(prefix, indexAt(prefix, at)))
  }

  // Marker windows for what the evenly spaced ones leave unread.
  const isCovered = (pos: number): boolean => spans.some(([s, e]) => pos >= s && pos < e)
  const hits: number[] = []
  MARKER_RE.lastIndex = 0
  for (let m = MARKER_RE.exec(text); m !== null && hits.length < MAX_MARKERS; m = MARKER_RE.exec(text)) {
    if (!isCovered(m.index)) hits.push(m.index)
  }
  for (let k = 0; k < MAX_MARKER_WINDOWS && hits.length; k++) {
    // The window that holds the most uncovered markers, starting a quarter
    // budget before one of them; earliest on a tie. Two pointers over the
    // sorted hits, so linear in their number.
    let best = -1
    let bestCount = 0
    let j = 0
    for (let i = 0; i < hits.length; i++) {
      const start = indexAt(prefix, Math.max(0, (prefix[hits[i]!] ?? 0) - (WINDOW_TOKENS >> 2)))
      const [, end] = windowFrom(prefix, start)
      if (j < i) j = i
      while (j < hits.length && hits[j]! < end) j++
      if (j - i > bestCount) { bestCount = j - i; best = i }
    }
    if (best < 0) break
    const start = indexAt(prefix, Math.max(0, (prefix[hits[best]!] ?? 0) - (WINDOW_TOKENS >> 2)))
    const span = windowFrom(prefix, start)
    spans.push(span)
    const rest = hits.filter(h => h < span[0] || h >= span[1])
    hits.length = 0
    hits.push(...rest)
  }

  spans.sort((a, b) => a[0] - b[0])
  return spans.map(([s, e]) => text.slice(s, e))
}
