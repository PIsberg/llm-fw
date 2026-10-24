/**
 * The first key that appears twice in one JSON object of `body`, or null.
 *
 * `body` must already be valid JSON (the caller has run JSON.parse on it);
 * this only walks the text. JSON.parse keeps the LAST value of a repeated key,
 * so a provider whose parser keeps the first would act on text the pipeline
 * never scanned. Keys compare after unescaping, so `"content"` and
 * `"content"` are the same key. One linear pass over the text.
 */
export function duplicateKey(body: string): string | null {
  // One entry per open container: a Set of keys for an object, null for an array.
  const stack: (Set<string> | null)[] = []
  // True when the next string in the current object is a key, not a value.
  let expectKey = false
  const n = body.length

  for (let i = 0; i < n; i++) {
    const c = body.charCodeAt(i)
    if (c === 0x22 /* " */) {
      const start = i
      let escaped = false
      for (i++; i < n; i++) {
        const d = body.charCodeAt(i)
        if (d === 0x5c /* \ */) {
          escaped = true
          i++
        } else if (d === 0x22) {
          break
        }
      }
      const keys = stack[stack.length - 1]
      if (expectKey && keys) {
        const raw = body.slice(start, i + 1)
        const key = escaped ? (JSON.parse(raw) as string) : raw.slice(1, -1)
        if (keys.has(key)) return key
        keys.add(key)
        expectKey = false
      }
    } else if (c === 0x7b /* { */) {
      stack.push(new Set())
      expectKey = true
    } else if (c === 0x5b /* [ */) {
      stack.push(null)
      expectKey = false
    } else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
      stack.pop()
      expectKey = false
    } else if (c === 0x2c /* , */) {
      // After a comma inside an object comes the next key.
      expectKey = stack[stack.length - 1] != null
    }
  }
  return null
}
