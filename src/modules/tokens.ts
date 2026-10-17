// Dependency-free token estimate for module savings.
//
// chars/4 counts whitespace as text, so collapsing a run of spaces "saved"
// a token per four spaces where a BPE tokenizer encodes the run as one token.
// Against cl100k and o200k on LF-normalised samples it overstated the
// pruner's saving on column-aligned tool output by 75% (1,395 estimated, 797
// real), and missed total counts by 33% on JSON and 58% on base64. This one
// walks the text once in pieces the way a BPE pre-tokenizer does and charges
// each piece; mean error against the mean of cl100k and o200k: prose 4.3%,
// code 6.3%, JSON 7.7%, prompts 7.8%, multilingual 8.3%, tool output 7.9%,
// base64/hex 28% (chars/4: 8.0, 6.4, 33.4, 20.8, 28.9, 16.2, 57.9). Claude's
// tokenizer is not public, so these are the closest public references.

// Characters per token in a run of ASCII letters, digits, ASCII punctuation,
// and non-ASCII non-CJK letters. Fitted by grid search over repository docs,
// source, package-lock.json, the detection corpora and `ls`/`git log`
// output, 2026-10-17.
const LETTERS = 12
const PUNCT = 4
const DIGITS = 3
const OTHER = 2.5

const isSpace = (c: number): boolean => c === 32 || c === 9
const isBreak = (c: number): boolean => c === 10 || c === 13
const isLetter = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90)
const isDigit = (c: number): boolean => c >= 48 && c <= 57
// CJK ideographs, kana and hangul: about one token per character.
const isCjk = (c: number): boolean =>
  (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff)

export function estimateTokens(text: string): number {
  if (!text) return 0
  const len = text.length
  let n = 0
  let i = 0
  while (i < len) {
    const c = text.charCodeAt(i)
    let j = i + 1
    if (isSpace(c)) {
      while (j < len && isSpace(text.charCodeAt(j))) j++
      // One space joins the word after it. A longer run is one token, and
      // so is whitespace before a line break or the end of the text.
      if (j - i > 1 || j === len || isBreak(text.charCodeAt(j))) n++
    } else if (isBreak(c)) {
      // A run of line breaks is one token, and so is each stretch of spaces
      // inside it (a whitespace-only line). Indentation after the last break
      // is one more, unless it is a single space, which joins the next word.
      n++
      let lastBreak = i
      let inSpaces = false
      while (j < len && (isBreak(text.charCodeAt(j)) || isSpace(text.charCodeAt(j)))) {
        if (isBreak(text.charCodeAt(j))) {
          if (inSpaces) n++
          inSpaces = false
          lastBreak = j
        } else {
          inSpaces = true
        }
        j++
      }
      if (j - lastBreak - 1 > 1) n++
    } else if (isLetter(c)) {
      while (j < len && isLetter(text.charCodeAt(j))) j++
      n += Math.ceil((j - i) / LETTERS)
    } else if (isDigit(c)) {
      while (j < len && isDigit(text.charCodeAt(j))) j++
      n += Math.ceil((j - i) / DIGITS)
    } else if (c < 128) {
      while (j < len) {
        const d = text.charCodeAt(j)
        if (d >= 128 || isSpace(d) || isBreak(d) || isLetter(d) || isDigit(d)) break
        j++
      }
      n += Math.ceil((j - i) / PUNCT)
    } else if (isCjk(c)) {
      n++
    } else {
      while (j < len) {
        const d = text.charCodeAt(j)
        if (d < 128 || isCjk(d)) break
        j++
      }
      n += Math.ceil((j - i) / OTHER)
    }
    i = j
  }
  return n
}
