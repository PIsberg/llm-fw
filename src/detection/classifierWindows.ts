/**
 * The windows a sequence classifier reads of a long text (#858).
 *
 * Both classifiers (Stage 2.5's DeBERTa and the response moderation model)
 * read 512 tokens, about 2,000 characters of prose, and were given the first
 * 4,000 characters of a text: anything after the opening ~2 KB of a fetched
 * page, a file or a long generation was never read, so a payload placed after
 * some filler passed. A long text is now read as at most MAX_CLASSIFIER_WINDOWS
 * windows of CLASSIFIER_WINDOW_CHARS, the first at the start, the last at the
 * end and the rest evenly between, like the embedding stage's sampled chunks;
 * the caller keeps the highest score. Bounded on purpose: each window is a
 * forward pass, and the tokenizer is superlinear in what it is given, which
 * is what the old 4,000-character cut also guarded against.
 */
export const CLASSIFIER_WINDOW_CHARS = 2000
export const MAX_CLASSIFIER_WINDOWS = 4

export function classifierWindows(text: string): string[] {
  if (text.length <= CLASSIFIER_WINDOW_CHARS) return [text]
  const count = Math.min(MAX_CLASSIFIER_WINDOWS, Math.ceil(text.length / CLASSIFIER_WINDOW_CHARS))
  const lastStart = text.length - CLASSIFIER_WINDOW_CHARS
  return Array.from({ length: count }, (_, i) => {
    const start = Math.round((i * lastStart) / (count - 1))
    return text.slice(start, start + CLASSIFIER_WINDOW_CHARS)
  })
}
