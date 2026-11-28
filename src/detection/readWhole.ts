import type { ClassifyFn } from './classifier.js'

/** What the classifiers' models read of one input (DeBERTa-v3 and DistilRoBERTa). */
export const MODEL_MAX_TOKENS = 512
// A piece's budget: room for the special tokens and for the overlap below.
const PIECE_TOKENS = 480
// Characters adjacent pieces share, so a payload on a seam is read whole.
const OVERLAP_CHARS = 64
// A piece still over the limit is split again, at most this deep.
const MAX_DEPTH = 3

type Tokenizer = (text: string) => { input_ids?: { dims?: readonly number[] } }

/**
 * A classifier that reads every token of what it is given (#951).
 *
 * The windows are laid out by an estimate of the tokenizer's count
 * (classifierWindows.ts), which undercounts non-English text written in plain
 * ASCII letters: on the Aya sample 74 of 2,955 windows ran past 512 real
 * tokens, up to 826, and the model reads only the first 512. Here, where the
 * model and its own tokenizer live (the inference worker, or in-process), a
 * window that runs over is read in pieces of at most PIECE_TOKENS tokens,
 * overlapping by OVERLAP_CHARS, and the piece that scores highest stands for
 * the window. A window that fits is passed through unchanged, so its score
 * is what it was. `scoreOf` reads the score that counts from one output.
 */
export function readWhole(classify: ClassifyFn, scoreOf: (out: { label: string; score: number }[]) => number): ClassifyFn {
  const tokenizer = (classify as unknown as { tokenizer?: Tokenizer }).tokenizer
  if (typeof tokenizer !== 'function') return classify
  const tokens = (text: string): number => tokenizer(text).input_ids?.dims?.at(-1) ?? 0

  const readOne = async (text: string, depth: number, opts?: { topk?: number }): Promise<{ label: string; score: number }[]> => {
    const n = tokens(text)
    if (n <= MODEL_MAX_TOKENS || depth >= MAX_DEPTH) return classify(text, opts)
    const pieces = Math.ceil(n / PIECE_TOKENS)
    const step = Math.ceil(text.length / pieces)
    let best: { label: string; score: number }[] | null = null
    let bestScore = -1
    for (let i = 0; i < pieces; i++) {
      const start = Math.max(0, i * step - OVERLAP_CHARS)
      const end = Math.min(text.length, (i + 1) * step + OVERLAP_CHARS)
      const out = await readOne(text.slice(start, end), depth + 1, opts)
      const s = scoreOf(out)
      if (s > bestScore) {
        bestScore = s
        best = out
      }
    }
    return best ?? classify(text, opts)
  }

  const wrapped = ((text: string, opts?: { topk?: number }) => readOne(text, 0, opts)) as ClassifyFn
  return Object.assign(wrapped, { tokenizer })
}
