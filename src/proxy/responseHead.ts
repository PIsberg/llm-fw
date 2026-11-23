/**
 * The head of an HTTP/1.1 response, read off the upstream socket by the
 * forward proxy (#855). Node's own client parser is not in that path: the
 * proxy writes the request and reads the bytes itself, so it owns framing.
 */

/** The most a response head, interim 1xx heads included, may take. */
export const MAX_RESPONSE_HEAD_BYTES = 64 * 1024

export interface ResponseHead {
  statusLine: string
  status: number
  /** Lowercase names. Set-Cookie keeps one entry per line; any other repeated field is joined with ", ". */
  headers: Record<string, string | string[]>
  /** Offset in the raw text where the body starts. */
  bodyStart: number
}

const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: |$)/
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/

/**
 * Parse the response head at the start of `raw` (latin1 text). Returns null
 * while the head is incomplete, and throws on one that is malformed or over
 * MAX_RESPONSE_HEAD_BYTES.
 *
 * - An interim 1xx response (100 Continue, 103 Early Hints) is skipped: read
 *   as the final one, the real status line and headers went to the client as
 *   body bytes. 101 is final.
 * - A header line splits at its first ':' with the value trimmed, as RFC 9110
 *   allows no space after the colon; `Transfer-Encoding:chunked` was dropped
 *   and its chunk framing forwarded as body.
 * - Repeated Set-Cookie lines are kept apart; every other repeated field is
 *   one comma-joined value, as RFC 9110 permits. Each used to overwrite the
 *   last.
 */
export function parseResponseHead(raw: string): ResponseHead | null {
  let offset = 0
  for (;;) {
    const sep = raw.indexOf('\r\n\r\n', offset)
    if (sep === -1 ? raw.length > MAX_RESPONSE_HEAD_BYTES : sep + 4 > MAX_RESPONSE_HEAD_BYTES) {
      throw new Error(`upstream response head over ${MAX_RESPONSE_HEAD_BYTES} bytes`)
    }
    if (sep === -1) return null
    const lines = raw.slice(offset, sep).split('\r\n')
    const statusLine = lines[0] ?? ''
    const m = STATUS_LINE.exec(statusLine)
    if (!m) throw new Error(`malformed upstream status line: ${JSON.stringify(statusLine.slice(0, 80))}`)
    const status = Number(m[1])
    if (status >= 100 && status < 200 && status !== 101) {
      offset = sep + 4
      continue
    }
    const headers: Record<string, string | string[]> = {}
    for (const line of lines.slice(1)) {
      const ci = line.indexOf(':')
      const name = line.slice(0, Math.max(ci, 0)).toLowerCase()
      if (ci <= 0 || !TOKEN.test(name)) throw new Error(`malformed upstream header line: ${JSON.stringify(line.slice(0, 80))}`)
      const value = line.slice(ci + 1).trim()
      const prev = headers[name]
      if (prev === undefined) headers[name] = value
      else if (name === 'set-cookie') headers[name] = Array.isArray(prev) ? [...prev, value] : [prev, value]
      else headers[name] = `${Array.isArray(prev) ? prev.join(', ') : prev}, ${value}`
    }
    return { statusLine, status, headers, bodyStart: sep + 4 }
  }
}
