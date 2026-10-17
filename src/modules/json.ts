/**
 * `text` with the whitespace outside JSON strings removed, or null when the
 * text is not a JSON object or array. Lexical on purpose: JSON.parse and
 * stringify would round 12345678901234567890 to 12345678901234567000 and 1.50
 * to 1.5, and the model then sees, and quotes back, a value nobody sent.
 */
export function minifyJsonText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    JSON.parse(trimmed)
  } catch {
    return null
  }
  let out = ''
  let inString = false
  let start = 0
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i)
    if (inString) {
      if (c === 92) i++ // backslash: skip the escaped character
      else if (c === 34) inString = false
    } else if (c === 34) {
      inString = true
    } else if (c === 32 || c === 9 || c === 10 || c === 13) {
      out += trimmed.slice(start, i)
      start = i + 1
    }
  }
  return out + trimmed.slice(start)
}
