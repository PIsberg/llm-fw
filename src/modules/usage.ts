import zlib from 'node:zlib'

/** Tokens a provider billed for one response, normalised across providers. */
export interface Usage {
  /** Input tokens billed at the full rate: neither read from nor written to a cache. */
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// A usage block sits in a response of at most a few megabytes. The capture is
// capped on the wire, but a compressed body is not capped in what it expands
// to: 200 MB of one byte gzips to about 200 KB.
const MAX_DECODED = 16 * 1024 * 1024

// Null when the body cannot be decoded or expands past `maxDecoded`
// (zlib throws a RangeError there).
function decode(body: Buffer, encoding: string, maxDecoded: number): string | null {
  try {
    const opts = { maxOutputLength: maxDecoded }
    const enc = encoding.toLowerCase().trim()
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(body, opts).toString('utf8')
    if (enc === 'br') return zlib.brotliDecompressSync(body, opts).toString('utf8')
    if (enc === 'deflate') return zlib.inflateSync(body, opts).toString('utf8')
    return body.toString('utf8')
  } catch {
    return null
  }
}

// Folds one JSON object (a whole response, or one SSE event) into the running
// usage. Later events win field by field: Anthropic sends input and cache
// counts in message_start and the final output count in the last
// message_delta; Gemini repeats cumulative usageMetadata on every chunk.
function fold(acc: Usage | null, data: unknown): Usage | null {
  if (!isObj(data)) return acc
  const out = (): Usage => acc ?? { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }

  // Anthropic: message_start carries the usage on the message.
  const message = isObj(data.message) ? data.message : undefined
  // Responses API: response.completed carries it on the response.
  const response = isObj(data.response) ? data.response : undefined
  const u = isObj(data.usage) ? data.usage : isObj(message?.usage) ? message.usage : isObj(response?.usage) ? response.usage : undefined

  if (u) {
    const next = out()
    if ('prompt_tokens' in u) {
      // OpenAI chat completions: cached tokens are part of prompt_tokens.
      const cached = num(isObj(u.prompt_tokens_details) ? u.prompt_tokens_details.cached_tokens : 0)
      next.inputTokens = num(u.prompt_tokens) - cached
      next.cacheReadTokens = cached
      next.outputTokens = num(u.completion_tokens)
    } else if (isObj(u.input_tokens_details)) {
      // Responses API: cached tokens are part of input_tokens.
      const cached = num(u.input_tokens_details.cached_tokens)
      next.inputTokens = num(u.input_tokens) - cached
      next.cacheReadTokens = cached
      next.outputTokens = num(u.output_tokens)
    } else {
      // Anthropic: input_tokens is the uncached part; a message_delta may
      // carry only output_tokens, so absent fields keep their earlier value.
      if ('input_tokens' in u) next.inputTokens = num(u.input_tokens)
      if ('cache_read_input_tokens' in u) next.cacheReadTokens = num(u.cache_read_input_tokens)
      if ('cache_creation_input_tokens' in u) next.cacheWriteTokens = num(u.cache_creation_input_tokens)
      if ('output_tokens' in u) next.outputTokens = num(u.output_tokens)
    }
    return next
  }

  if (isObj(data.usageMetadata)) {
    // Gemini: cached tokens are part of promptTokenCount.
    const m = data.usageMetadata
    const cached = num(m.cachedContentTokenCount)
    const next = out()
    next.inputTokens = num(m.promptTokenCount) - cached
    next.cacheReadTokens = cached
    next.outputTokens = num(m.candidatesTokenCount)
    return next
  }
  return acc
}

type ResponseHeaders = Record<string, string | string[] | number | undefined>

/**
 * The JSON a response body carries, decoded per `content-encoding`: the body
 * itself, or the data of each server-sent event in order. Null when the body
 * cannot be decoded, or is a JSON object that does not parse.
 */
export function responseEvents(body: Buffer, headers: ResponseHeaders, maxDecoded = MAX_DECODED): unknown[] | null {
  const text = decode(body, String(headers['content-encoding'] ?? ''), maxDecoded)
  if (text === null) return null
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as unknown]
    } catch {
      return null
    }
  }
  const events: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload.startsWith('{')) continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      // a partial or non-JSON event; the rest of the stream may still be read
    }
  }
  return events
}

/**
 * The usage a provider reported in a response body, JSON or server-sent
 * events, decoded per `content-encoding`. Null when the body carries none.
 */
export function parseUsage(body: Buffer, headers: ResponseHeaders, maxDecoded = MAX_DECODED): Usage | null {
  const events = responseEvents(body, headers, maxDecoded)
  return events ? events.reduce<Usage | null>((acc, data) => fold(acc, data), null) : null
}
