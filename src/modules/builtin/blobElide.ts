import crypto from 'node:crypto'
import type { BlobElideConfig } from '../../types.js'
import { SlotModule } from '../base.js'
import type { SlotKind } from '../payload.js'

const patterns = new Map<number, RegExp>()

// Base64, base64url and hex share this alphabet. Built per minimum length,
// and cached, because the length is part of the pattern.
function blobPattern(minLength: number): RegExp {
  let re = patterns.get(minLength)
  if (!re) {
    re = new RegExp(`[A-Za-z0-9+/_-]{${minLength},}={0,2}`, 'g')
    patterns.set(minLength, re)
  }
  return re
}

/**
 * Every run of at least `minLength` base64 or hex characters replaced with a
 * marker naming its length and the first 8 hex digits of its SHA-256, so two
 * different blobs stay distinguishable and the same blob always reads the
 * same. A run needs a digit and a letter: a long word is not a blob. The
 * marker holds no quote or backslash, so a blob inside a JSON string leaves
 * the JSON valid.
 */
export function elideBlobs(text: string, minLength: number): string {
  const min = Math.max(64, Math.floor(minLength))
  if (text.length < min) return text
  return text.replace(blobPattern(min), blob => {
    if (!/[0-9]/.test(blob) || !/[A-Za-z]/.test(blob)) return blob
    const hash = crypto.createHash('sha256').update(blob).digest('hex').slice(0, 8)
    return `[llm-fw: ${blob.length}-character base64 blob elided, sha256 ${hash}]`
  })
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
