// Line-end trimming without a regex. /[ \t]+$/ and its relatives restart at
// every whitespace character of a run that does not reach the end of the
// line, which is quadratic in the run: one 40,000-space run cost 1-3 s of
// event-loop time. These walk back from the end once.

const WHITESPACE = /\s/

/** `line` without trailing whitespace other than CR and LF. */
export function trimLineEnd(line: string): string {
  let end = line.length
  while (end > 0) {
    const c = line[end - 1]!
    if (c === '\r' || c === '\n' || !WHITESPACE.test(c)) break
    end--
  }
  return end === line.length ? line : line.slice(0, end)
}

// One space or tab right before a line end: a constant-width match, so the
// test is a single pass. Lets text with nothing to trim skip the split.
const SPACE_AT_LINE_END = /[ \t](?:\r?\n|\r?$)/

/** Every line of `text` without the spaces and tabs at its end; a CR before the LF stays. */
export function trimSpacesAtLineEnds(text: string): string {
  if (!SPACE_AT_LINE_END.test(text)) return text
  return text.split('\n').map(line => {
    const cr = line.endsWith('\r')
    let end = cr ? line.length - 1 : line.length
    const stop = end
    while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--
    return end === stop ? line : line.slice(0, end) + (cr ? '\r' : '')
  }).join('\n')
}
