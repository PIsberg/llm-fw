import crypto from 'node:crypto'
import type { BlobElideConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'

// Base64, base64url and hex share this alphabet.
const isBlobChar = (c: number): boolean =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 95 || c === 45

/**
 * Every run of at least `minLength` base64 or hex characters replaced with a
 * marker naming its length and the first 8 hex digits of its SHA-256, so two
 * different blobs stay distinguishable and the same blob always reads the
 * same. A run needs a digit and a letter: a long word is not a blob. The
 * marker holds no quote or backslash, so a blob inside a JSON string leaves
 * the JSON valid.
 *
 * One pass over character codes. A minimum inside a regex ({2048,}) rescanned
 * a run just shorter than it from every start position (1.7 s on 512 KB),
 * and a replace callback per maximal run cost 90 ms on 2 MB of source code,
 * where nearly every word is a run.
 */
export function elideBlobs(text: string, minLength: number): string {
  const min = Math.max(64, Math.floor(minLength))
  if (text.length < min) return text
  let out = ''
  let copied = 0
  let i = 0
  while (i < text.length) {
    if (!isBlobChar(text.charCodeAt(i))) { i++; continue }
    const start = i
    let digit = false
    let letter = false
    while (i < text.length) {
      const c = text.charCodeAt(i)
      if (!isBlobChar(c)) break
      if (c >= 48 && c <= 57) digit = true
      else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letter = true
      i++
    }
    // Up to two padding characters belong to the blob.
    if (text.charCodeAt(i) === 61) i++
    if (text.charCodeAt(i) === 61) i++
    if (i - start < min || !digit || !letter) continue
    const blob = text.slice(start, i)
    const hash = crypto.createHash('sha256').update(blob).digest('hex').slice(0, 8)
    out += text.slice(copied, start) + `[llm-fw: ${blob.length}-character base64 blob elided, sha256 ${hash}]`
    copied = i
  }
  return copied === 0 ? text : out + text.slice(copied)
}

const TOOL_OUTPUT: ReadonlySet<SlotKind> = new Set(['tool_result'])

/**
 * Base64 and hex blobs in tool output: an embedded image in an API response,
 * a certificate, a minified bundle's source map. A model cannot read them,
 * and they cost about a token per three characters. Tool output only: a
 * user who pastes base64 into a prompt may want it decoded.
 */
export class BlobElideModule extends SlotModule<BlobElideConfig> {
  readonly id = 'blob-elide'
  readonly name = 'Blob Elider'
  readonly description = 'Replaces long base64 and hex runs in tool output with their length and a short hash'
  protected readonly kinds = TOOL_OUTPUT

  constructor(config?: BlobElideConfig) {
    super(config ?? { enabled: false, minLength: 2048 })
  }

  protected rewrite(text: string): string {
    return elideBlobs(text, this.cfg.minLength)
  }
}
