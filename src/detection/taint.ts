import { calculateEntropy } from './normalize.js'

/**
 * Cross-turn taint tracking — an information-flow signal, not a content
 * classifier.
 *
 * The premise: prompt injection is not a property of text in isolation, it is a
 * property of TRUST. The dangerous event is not "untrusted content contained a
 * scary string" but "data that entered through an untrusted channel went on to
 * drive an outbound action." That flow is observable at a network proxy and is
 * independent of how the injection was phrased, so it sidesteps the evasion
 * arms race that defeats regex/embedding/judge classification.
 *
 * Source  — text the model ingested from an untrusted channel (tool results,
 *           retrieved documents). We extract distinctive, low-false-positive
 *           tokens from it: hostnames/URLs and high-entropy secret-like values.
 * Sink    — a subsequent outbound request (its destination host + path/query).
 * Finding — a sink reuses a token first seen in a prior source within the same
 *           session. e.g. the agent connects to a host that only ever appeared
 *           inside a fetched web page → it was told to by untrusted content.
 *
 * State is per-session (keyed by the client by the caller — typically source
 * IP), TTL-bounded, and size-capped so it cannot grow without bound.
 */

export type TaintCategory = 'host' | 'secret'

export interface TaintFinding {
  token: string
  category: TaintCategory
}

interface TokenMeta {
  category: TaintCategory
  ts: number
}

interface SessionTaint {
  tokens: Map<string, TokenMeta>
  lastSeen: number
}

const TTL_MS = 30 * 60 * 1000
const MAX_SESSIONS = 1000
const MAX_TOKENS_PER_SESSION = 256

// TLD-position labels that are almost always file extensions or code, not real
// domains — keeps "index.html", "app.config.js", "data.json" out of the host set.
const FILE_EXT_TLDS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'json', 'md', 'txt', 'py', 'rb', 'go', 'rs', 'java',
  'html', 'htm', 'css', 'scss', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'config',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'csv', 'log', 'sh', 'env', 'lock',
])

const URL_HOST_RE = /https?:\/\/([a-z0-9.-]+)/gi
const BARE_DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]{1,23})\b/gi
const SECRET_TOKEN_RE = /[A-Za-z0-9_-]{20,}/g

function hasLetter(s: string): boolean { return /[A-Za-z]/.test(s) }
function hasDigit(s: string): boolean { return /[0-9]/.test(s) }

/**
 * Pull distinctive tokens out of untrusted text. Deliberately conservative —
 * taint is only useful if its tokens rarely recur by coincidence:
 *   • hosts   — URL hosts + bare domains (minus file-extension look-alikes)
 *   • secrets — ≥20-char alnum runs that mix letters and digits with high
 *               entropy (API keys, IDs, base64 blobs) — not ordinary prose
 */
export function extractTaintTokens(text: string): TaintFinding[] {
  const found = new Map<string, TaintCategory>()
  const lower = text.toLowerCase()

  for (const m of lower.matchAll(URL_HOST_RE)) {
    const host = m[1]
    if (host && host.includes('.')) found.set(host, 'host')
  }
  for (const m of lower.matchAll(BARE_DOMAIN_RE)) {
    const domain = m[1]
    const tld = domain.slice(domain.lastIndexOf('.') + 1)
    if (!FILE_EXT_TLDS.has(tld)) found.set(domain, 'host')
  }
  for (const m of text.matchAll(SECRET_TOKEN_RE)) {
    const tok = m[0]
    const start = m.index ?? 0
    const before = start > 0 ? text[start - 1] : ''
    const after = text[start + tok.length] ?? ''
    // A run adjacent to a '.' is a domain label (e.g. "us-central1-aiplatform"
    // in a Vertex hostname), not a secret — hosts are handled above. Skipping
    // these avoids tainting legitimate long hyphenated subdomains.
    if (before === '.' || after === '.') continue
    if (hasLetter(tok) && hasDigit(tok) && calculateEntropy(tok) >= 3.3) {
      found.set(tok.toLowerCase(), 'secret')
    }
  }

  return Array.from(found, ([token, category]) => ({ token, category }))
}

/** Mask a token for logging — never emit a raw secret to the event stream. */
export function maskToken(token: string): string {
  if (token.length <= 8) return token[0] + '…' + token.slice(-1)
  return token.slice(0, 4) + '…' + token.slice(-3)
}

export class TaintTracker {
  private sessions = new Map<string, SessionTaint>()
  private readonly benignHosts: Set<string>

  /**
   * @param benignHosts hosts that must never be treated as taint — the LLM
   *        provider/target hosts. Without this, a provider domain mentioned in a
   *        tool result would taint the very next (legitimate) provider request.
   */
  constructor(benignHosts: Iterable<string> = []) {
    this.benignHosts = new Set(Array.from(benignHosts, h => h.toLowerCase()))
  }

  /** Record untrusted source text's distinctive tokens against a session. */
  recordSource(sessionKey: string, untrustedText: string, now: number): void {
    if (!untrustedText) return
    const tokens = extractTaintTokens(untrustedText).filter(
      t => !(t.category === 'host' && this.isBenignHost(t.token))
    )
    if (!tokens.length) return

    let session = this.sessions.get(sessionKey)
    if (!session) {
      session = { tokens: new Map(), lastSeen: now }
      this.sessions.set(sessionKey, session)
    }
    for (const t of tokens) session.tokens.set(t.token, { category: t.category, ts: now })
    session.lastSeen = now

    this.evictSessionTokens(session, now)
    this.evictSessions(now)
  }

  /**
   * Return taint tokens that reappear in this sink (destination host +
   * path/query, lower-cased by the caller or here). Empty when the session has
   * no live taint or nothing matches.
   */
  checkSink(sessionKey: string, sinkText: string, now: number): TaintFinding[] {
    const session = this.sessions.get(sessionKey)
    if (!session) return []
    this.evictSessionTokens(session, now)

    const hay = sinkText.toLowerCase()
    const findings: TaintFinding[] = []
    for (const [token, meta] of session.tokens) {
      if (hay.includes(token)) findings.push({ token, category: meta.category })
    }
    if (findings.length) session.lastSeen = now
    return findings
  }

  private isBenignHost(host: string): boolean {
    if (this.benignHosts.has(host)) return true
    // A subdomain of a benign provider host is also benign (e.g. a regional
    // Vertex endpoint under googleapis.com).
    for (const b of this.benignHosts) {
      if (host.endsWith('.' + b)) return true
    }
    return false
  }

  private evictSessionTokens(session: SessionTaint, now: number): void {
    for (const [token, meta] of session.tokens) {
      if (now - meta.ts > TTL_MS) session.tokens.delete(token)
    }
    // Cap size — drop the oldest tokens first.
    if (session.tokens.size > MAX_TOKENS_PER_SESSION) {
      const ordered = Array.from(session.tokens.entries()).sort((a, b) => a[1].ts - b[1].ts)
      for (let i = 0; i < ordered.length - MAX_TOKENS_PER_SESSION; i++) {
        session.tokens.delete(ordered[i][0])
      }
    }
  }

  private evictSessions(now: number): void {
    for (const [key, session] of this.sessions) {
      if (now - session.lastSeen > TTL_MS || session.tokens.size === 0) {
        this.sessions.delete(key)
      }
    }
    if (this.sessions.size > MAX_SESSIONS) {
      const ordered = Array.from(this.sessions.entries()).sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      for (let i = 0; i < ordered.length - MAX_SESSIONS; i++) {
        this.sessions.delete(ordered[i][0])
      }
    }
  }
}
