import type http from 'node:http'
import { StringDecoder } from 'node:string_decoder'

// One server-sent event ends at a blank line, LF or CRLF framed.
const EVENT_END_RE = /\r?\n\r?\n/

/** True for an OpenAI chat completions chunk that carries usage and no choices. */
function isUsageOnly(event: string): boolean {
  const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
  if (!data.startsWith('{')) return false
  try {
    const chunk = JSON.parse(data) as { choices?: unknown; usage?: unknown }
    return Array.isArray(chunk.choices) && chunk.choices.length === 0 && typeof chunk.usage === 'object' && chunk.usage !== null
  } catch {
    return false
  }
}

// The header object a writeHead call passes, if any: (status, headers) or (status, message, headers).
function headerArg(args: unknown[]): Record<string, unknown> | undefined {
  const last = args[args.length - 1]
  return typeof last === 'object' && last !== null && !Array.isArray(last) ? last as Record<string, unknown> : undefined
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string {
  if (!headers) return ''
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? String(v) : ''
  return ''
}

/**
 * Drops the usage-only chunk from an OpenAI-style chat completions stream on
 * its way to the client (#421). The stream usage reporter asks the provider
 * for that chunk so the Usage Meter can count the stream; a client that did
 * not ask for it can crash on it (reading `choices[0]` unchecked throws, in
 * openai-node and openai-python alike, measured for #414).
 *
 * Install it on `res` before `tapResponse`, so the tap still records what the
 * provider sent. It acts only on a `text/event-stream` response without a
 * content-encoding; anything else passes through untouched. Events are held
 * only until their blank-line end arrives, so the stream keeps streaming.
 */
export function stripUsageChunk(res: http.ServerResponse): void {
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse
  const write = res.write.bind(res) as (...args: unknown[]) => boolean
  const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse
  let decided = false
  let active = false
  const decoder = new StringDecoder('utf8')
  let pending = ''

  const decide = (args: unknown[] = []): void => {
    if (decided) return
    decided = true
    const passed = headerArg(args)
    const type = headerValue(passed, 'content-type') || headerValue({ v: res.getHeader('content-type') }, 'v')
    const encoding = headerValue(passed, 'content-encoding') || headerValue({ v: res.getHeader('content-encoding') }, 'v')
    active = /text\/event-stream/i.test(type) && (encoding === '' || encoding.toLowerCase() === 'identity')
  }

  // The complete events in `pending`, minus the usage-only one; the rest stays pending.
  const drain = (final: boolean): string => {
    let out = ''
    for (;;) {
      const m = EVENT_END_RE.exec(pending)
      if (!m) break
      const event = pending.slice(0, m.index + m[0].length)
      pending = pending.slice(m.index + m[0].length)
      if (!isUsageOnly(event)) out += event
    }
    if (final) {
      if (pending && !isUsageOnly(pending)) out += pending
      pending = ''
    }
    return out
  }

  const text = (chunk: unknown, encoding: unknown): string => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return ''
    if (typeof chunk === 'string') return decoder.write(Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'))
    return decoder.write(Buffer.from(chunk as Uint8Array))
  }

  res.writeHead = ((...args: unknown[]) => {
    decide(args)
    if (active) {
      // Dropping bytes would make a declared length wrong.
      const passed = headerArg(args)
      if (passed) for (const k of Object.keys(passed)) if (k.toLowerCase() === 'content-length') delete passed[k]
      res.removeHeader('content-length')
    }
    return writeHead(...args)
  })

  res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    decide()
    if (!active) return write(chunk, encoding, cb)
    pending += text(chunk, encoding)
    const out = drain(false)
    const done = typeof encoding === 'function' ? encoding : cb
    if (!out) {
      if (typeof done === 'function') process.nextTick(done)
      return true
    }
    return typeof done === 'function' ? write(out, done) : write(out)
  }) as typeof res.write

  res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
    decide()
    if (!active) return end(chunk, encoding, cb)
    const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb
    pending += text(typeof chunk === 'function' ? undefined : chunk, encoding) + decoder.end()
    const out = drain(true)
    return typeof done === 'function' ? end(out, done) : end(out)
  }) as typeof res.end
}
