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
 * (tokenPrefix), WINDOW_TOKENS each and never more than MAX_WINDOW_CHARS,
 * a budget the p5 estimate keeps under 512 real tokens, so the model reads
 * each window whole: the first at the start, the last at the
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
// A window's length in characters, whatever the estimate: what the tokenizer
// is given stays bounded (a long run of whitespace is no tokens at all), and
// a run the estimate undercounts is cut here too (#898). 440 tokens of prose
// are about 2,300 characters.
export const MAX_WINDOW_CHARS = 2600
export const MAX_CLASSIFIER_WINDOWS = 4
export const MAX_MARKER_WINDOWS = 2


const isSpace = (c: number): boolean => c === 32 || c === 10 || c === 13 || c === 9
const MARK_RE = /[\p{M}\p{Cf}]/u
const LETTER_RE = /[\p{L}\p{N}]/u

// Estimated tokens are counted in sixteenths, so whitespace, which the
// tokenizer reads as nothing, still spreads the windows over a long run of it.
const UNIT = 16
// Adjacent windows share this many tokens, so a payload on a boundary is
// read whole by one of them.
const OVERLAP_TOKENS = 32

/**
 * 1 a digit, 2 an upper-case and 3 a lower-case ASCII letter; 4 a letter or
 * digit of any other script below U+2E80 (accented Latin, Cyrillic, Greek,
 * Arabic, Indic, Thai), which the tokenizer splits finer; 0 anything else.
 */
function charKind(text: string, i: number, c: number): number {
  if (c < 0x80) return (c >= 48 && c <= 57) ? 1 : (c >= 65 && c <= 90) ? 2 : (c >= 97 && c <= 122) ? 3 : 0
  if (c >= 0x2e80 || (c >= 0xd800 && c <= 0xdfff)) return 0
  const ch = text[i]!
  return !MARK_RE.test(ch) && LETTER_RE.test(ch) ? 4 : 0
}

/**
 * prefix[i] is the estimated token count of text.slice(0, i), in sixteenths
 * of a token, never decreasing. A run of ASCII letters and digits is one
 * token, plus one per change between digits, upper and lower case (a
 * capital opening a word excepted), plus one per 8 characters, or per 4 past
 * 16 (base64, hashes). A run of other letters is one token per 1.5 of them
 * (Aya's 70 languages, on the real tokenizer). Every combining mark and
 * format character (a zero-width space, a direction mark), every character
 * from U+2E80 up (CJK) and every punctuation mark or symbol is one token,
 * whitespace a sixteenth. Measured against the real tokenizer (#898): 0.89 /
 * 1.00 / 1.09 of its count at p5 / median / p95 on 1,652 local tool results,
 * 1.08 at the median on prose, exact on CJK, zero-width and combining runs.
 * Non-English text in plain ASCII letters is still undercounted (Aya: 0.60
 * at p5), which a layout by the real tokenizer would fix (#951); every
 * window is also cut at MAX_WINDOW_CHARS.
 */
function tokenPrefix(text: string): Uint32Array {
  const prefix = new Uint32Array(text.length + 1)
  let before = 0 // units before the current run
  let run = 0
  let trans = 0
  let prev = 0
  let last = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const kind = charKind(text, i, c)
    if (run && (kind === 0 || (kind === 4) !== (prev === 4))) { before = last; run = 0; trans = 0 }
    let now: number
    if (kind === 4) {
      run++
      prev = 4
      now = before + Math.ceil(run / 1.5) * UNIT
    } else if (kind) {
      if (run && kind !== prev && !(prev === 2 && kind === 3)) trans++
      run++
      prev = kind
      now = before + (1 + trans + Math.floor(run / (run > 16 ? 4 : 8))) * UNIT
    } else {
      before = last + (isSpace(c) ? 1 : UNIT)
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
  const limit = (prefix[start] ?? 0) + WINDOW_TOKENS * UNIT
  // The last index whose prefix is within the budget: the end of the text
  // when all of it is.
  const len = prefix.length - 1
  let end = (prefix[len] ?? 0) <= limit ? len : indexAt(prefix, limit + 1) - 1
  if (end <= start) end = Math.min(prefix.length - 1, start + 1)
  return [start, Math.min(end, start + MAX_WINDOW_CHARS)]
}

// Words and shapes injected instructions are made of. Only where they are
// dense counts, and only in text no window reads yet.
const MARKER_RE = /\b(?:ignore|disregard|forget|override|bypass|instructions?|prompt|developer|assistant|must|should|never|always|please|immediately|important|urgent|secret|password|credentials?|token|keys?|exfiltrate|send|forward|upload|curl|wget|execute|run)\b|<\/?[a-z][\w-]{0,30}>|\[\/?(?:inst|system)\]|https?:\/\//gi
const MAX_MARKERS = 20_000

export function classifierWindows(text: string): string[] {
  if (text.length <= 64) return [text]
  const prefix = tokenPrefix(text)
  const total = prefix[text.length] ?? 0
  const budget = WINDOW_TOKENS * UNIT
  if (total <= budget && text.length <= MAX_WINDOW_CHARS) return [text]

  // A text that MAX_CLASSIFIER_WINDOWS windows can cover is read end to end:
  // each window as long as both limits allow, the next starting
  // OVERLAP_TOKENS before it ends. Laid out by both measures at once, so a
  // window MAX_WINDOW_CHARS cuts short (whitespace, which the tokenizer reads
  // as nothing) leaves no stretch unread (#898, third review).
  const greedy: [number, number][] = []
  for (let start = 0; greedy.length < MAX_CLASSIFIER_WINDOWS;) {
    const span = windowFrom(prefix, start)
    greedy.push(span)
    if (span[1] >= text.length) return greedy.map(([s, e]) => text.slice(s, e))
    const back = indexAt(prefix, Math.max(0, (prefix[span[1]] ?? 0) - OVERLAP_TOKENS * UNIT))
    start = back > start ? Math.min(back, span[1]) : span[1]
  }

  // Longer: evenly spaced by tokens, the last ending at the end, then the
  // marker windows below for what they leave unread.
  const count = MAX_CLASSIFIER_WINDOWS
  const spans: [number, number][] = []
  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      // The last window ends at the end of the text.
      const start = Math.max(indexAt(prefix, Math.max(0, total - budget)), text.length - MAX_WINDOW_CHARS)
      spans.push([start, text.length])
      continue
    }
    const at = Math.round((i * Math.max(0, total - budget)) / (count - 1))
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
      const start = indexAt(prefix, Math.max(0, (prefix[hits[i]!] ?? 0) - (budget >> 2)))
      const [, end] = windowFrom(prefix, start)
      if (j < i) j = i
      while (j < hits.length && hits[j]! < end) j++
      if (j - i > bestCount) { bestCount = j - i; best = i }
    }
    if (best < 0) break
    const start = indexAt(prefix, Math.max(0, (prefix[hits[best]!] ?? 0) - (budget >> 2)))
    const span = windowFrom(prefix, start)
    spans.push(span)
    const rest = hits.filter(h => h < span[0] || h >= span[1])
    hits.length = 0
    hits.push(...rest)
  }

  spans.sort((a, b) => a[0] - b[0])
  return spans.map(([s, e]) => text.slice(s, e))
}
