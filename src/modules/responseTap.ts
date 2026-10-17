import type http from 'node:http'

/** A response as the client received it: status, headers and body bytes. */
export interface CapturedResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

function normaliseHeaders(input: unknown, into: Record<string, string>): void {
  if (Array.isArray(input)) {
    // Raw form: [name, value, name, value, ...]
    for (let i = 0; i + 1 < input.length; i += 2) into[String(input[i]).toLowerCase()] = String(input[i + 1])
  } else if (input && typeof input === 'object') {
    for (const [name, value] of Object.entries(input as Record<string, string | number | string[] | undefined>)) {
      if (value === undefined) continue
      into[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
    }
  }
}

/**
 * Records what is written to `res` without changing it, and returns a
 * function that yields the capture once the response has ended. Bytes still
 * stream to the client as they are written; the copy stops, and the capture
 * is null, once the body passes `maxBytes`, so a large download is never held
 * in memory twice.
 *
 * Wraps the three ServerResponse methods both listeners write through, the
 * proxy's piecewise writes and the gateway's pipe alike.
 */
export function tapResponse(res: http.ServerResponse, maxBytes: number): () => CapturedResponse | null {
  const headers: Record<string, string> = {}
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false

  const keep = (chunk: unknown, encoding?: unknown): void => {
    if (overflow || chunk === undefined || chunk === null || typeof chunk === 'function') return
    const buf = typeof chunk === 'string'
      ? Buffer.from(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
      : Buffer.from(chunk as Uint8Array)
    size += buf.length
    if (size > maxBytes) {
      overflow = true
      chunks.length = 0
      return
    }
    chunks.push(buf)
  }

  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse
  const write = res.write.bind(res) as (...args: unknown[]) => boolean
  const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse

  res.writeHead = ((...args: unknown[]) => {
    normaliseHeaders(res.getHeaders(), headers)
    // (status, headers) or (status, statusMessage, headers)
    normaliseHeaders(typeof args[1] === 'string' ? args[2] : args[1], headers)
    return writeHead(...args)
  })
  res.write = ((...args: unknown[]) => {
    keep(args[0], args[1])
    return write(...args)
  }) as typeof res.write
  res.end = ((...args: unknown[]) => {
    keep(args[0], args[1])
    return end(...args)
  }) as typeof res.end

  return () => {
    if (overflow || !res.writableEnded) return null
    // A response finished without writeHead (implicit headers) only has
    // what setHeader recorded.
    if (Object.keys(headers).length === 0) normaliseHeaders(res.getHeaders(), headers)
    return { status: res.statusCode, headers, body: Buffer.concat(chunks) }
  }
}
