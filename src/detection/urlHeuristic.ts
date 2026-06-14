import { UrlFilterConfig } from '../types.js'
import { calculateEntropy } from './normalize.js'

export interface UrlClassifyResult {
  action: 'block' | 'pass';
  reason: string;
}

interface CheckDetail {
  name: string;
  result: 'pass' | 'block';
  reason: string;
}

export interface UrlClassifyDetailedResult extends UrlClassifyResult {
  checks: CheckDetail[];
}

// Domains operated exclusively as exfiltration / webhook relay services
const KNOWN_EXFIL_DOMAINS = new Set([
  'webhook.site',
  'requestbin.com',
  'requestbin.net',
  'pipedream.net',
  'hookbin.com',
  'hookdeck.com',
  'ngrok.io',
  'ngrok-free.app',
  'burpcollaborator.net',
  'interact.sh',
  'canarytokens.com',
  'oast.fun',
  'oast.pro',
  'oast.live',
  'oast.site',
  'oast.online',
  'oast.me',
  'beeceptor.com',
  'mockbin.org',
  'svix.com',
  'smee.io',
])

// Subdomain labels used by DNS-over-HTTP tunneling tools
const DNS_TUNNEL_LABELS = /^(iodine|dnscat|dns2tcp|ozymandns|tcpoverdns|tuns)/i

// Query / path patterns that suggest outbound data exfiltration
const EXFIL_PATH_PATTERNS: RegExp[] = [
  // long base64 value in any parameter
  /[?&][^=&]{0,30}=[A-Za-z0-9+/]{60,}={0,2}(?:&|$)/,
  // long hex value in any parameter
  /[?&][^=&]{0,30}=[0-9a-f]{64,}(?:&|$)/i,
  // parameter names that semantically signal data being sent out
  /[?&](?:data|payload|content|secret|token|dump|exfil|send|out|leak|body|msg|text|info|result)=/i,
]

export class UrlClassifier {
  private allowlist: Set<string>
  private blocklist: Set<string>
  private entropyThreshold: number

  constructor(config: UrlFilterConfig) {
    this.allowlist = new Set(config.allowlistDomains.map(normalizeDomainEntry).filter(Boolean))
    this.blocklist = new Set(config.blocklistDomains.map(normalizeDomainEntry).filter(Boolean))
    this.entropyThreshold = config.entropyThreshold
  }

  classifyDetailed(hostname: string, path?: string): UrlClassifyDetailedResult {
    const checks: CheckDetail[] = []
    const host = hostname.toLowerCase()

    if (this.matchesList(host, this.allowlist)) {
      checks.push({ name: 'Allowlist', result: 'pass', reason: 'domain is explicitly allowlisted' })
      return { action: 'pass', reason: 'allowlisted', checks }
    }
    checks.push({ name: 'Allowlist', result: 'pass', reason: 'not in allowlist' })

    if (this.matchesList(host, this.blocklist)) {
      checks.push({ name: 'Blocklist', result: 'block', reason: 'domain is explicitly blocklisted' })
      return { action: 'block', reason: 'domain-blocklisted', checks }
    }
    checks.push({ name: 'Blocklist', result: 'pass', reason: 'not in blocklist' })

    const apex = apexDomain(host)
    if (KNOWN_EXFIL_DOMAINS.has(apex)) {
      checks.push({ name: 'Known exfil domain', result: 'block', reason: `${apex} is a known exfiltration service` })
      return { action: 'block', reason: 'known-exfil-domain', checks }
    }
    checks.push({ name: 'Known exfil domain', result: 'pass', reason: 'not a known exfil service' })

    for (const label of subdomainLabels(host)) {
      if (DNS_TUNNEL_LABELS.test(label)) {
        checks.push({ name: 'DNS tunnel label', result: 'block', reason: `subdomain "${label}" matches DNS tunneling tool pattern` })
        return { action: 'block', reason: 'dns-tunnel-label', checks }
      }
    }
    checks.push({ name: 'DNS tunnel label', result: 'pass', reason: 'no tunnel tool labels in subdomains' })

    // Entropy-screen both the subdomain labels AND the registrable (second-level)
    // label. A bare DGA domain like `kq3v9z7x1p2m4.com` has no subdomains, so the
    // random string lives in the registrable label itself — checking only
    // subdomains let every algorithmically-generated apex through. Same strict
    // gate (length ≥ 12 AND entropy ≥ threshold) keeps real words (github, google)
    // well under the bar.
    for (const label of entropyLabels(host)) {
      if (label.length >= 12) {
        const e = calculateEntropy(label)
        if (e >= this.entropyThreshold) {
          checks.push({ name: 'High-entropy host label', result: 'block', reason: `"${label.slice(0, 20)}" entropy ${e.toFixed(2)} ≥ ${this.entropyThreshold}` })
          return { action: 'block', reason: `high-entropy-host:${label.slice(0, 20)}`, checks }
        }
      }
    }
    checks.push({ name: 'High-entropy host label', result: 'pass', reason: 'no high-entropy host labels' })

    if (path) {
      for (const pattern of EXFIL_PATH_PATTERNS) {
        if (pattern.test(path)) {
          checks.push({ name: 'Path exfil pattern', result: 'block', reason: 'query string matches data exfiltration pattern' })
          return { action: 'block', reason: 'query-exfil-pattern', checks }
        }
      }
      checks.push({ name: 'Path exfil pattern', result: 'pass', reason: 'no suspicious query patterns' })
    }

    return { action: 'pass', reason: 'clean', checks }
  }

  classify(hostname: string, path?: string): UrlClassifyResult {
    const { action, reason } = this.classifyDetailed(hostname, path)
    return { action, reason }
  }

  /**
   * Screen a request path/query string for outbound data-exfiltration patterns,
   * independent of host allow/blocklisting. Used for intercepted requests where
   * the full decrypted path is available (the CONNECT handshake only exposes the
   * hostname), so the path-exfil heuristics actually run.
   */
  classifyPath(path: string): UrlClassifyResult {
    for (const pattern of EXFIL_PATH_PATTERNS) {
      if (pattern.test(path)) {
        return { action: 'block', reason: 'query-exfil-pattern' }
      }
    }
    return { action: 'pass', reason: 'clean' }
  }

  private matchesList(host: string, list: Set<string>): boolean {
    if (list.has(host)) return true
    const parts = host.split('.')
    for (let i = 1; i < parts.length; i++) {
      if (list.has(parts.slice(i).join('.'))) return true
    }
    return false
  }
}

/**
 * Normalize an allow/blocklist entry to the bare hostname the proxy actually
 * matches against. Operators naturally paste decorated forms — `https://host`,
 * `host/path`, `host:443`, `*.host`, `.host`, or with stray whitespace — and the
 * raw exact-string match silently failed on all of them, so a domain the user
 * "whitelisted" stayed blocked. Strip scheme, path, port, leading wildcard/dot
 * and whitespace, then lowercase. Returns '' for entries that reduce to nothing
 * (filtered out by the caller).
 */
export function normalizeDomainEntry(entry: string): string {
  let s = entry.trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme://
  s = s.split('/')[0] ?? ''                    // drop path/query
  s = s.split('@').pop() ?? ''                 // drop any userinfo
  // strip port — but keep IPv6 literals (which contain ':') intact when bracketed
  if (s.startsWith('[')) {
    s = s.replace(/^\[(.+?)\](?::\d+)?$/, '$1')
  } else {
    s = s.replace(/:\d+$/, '')
  }
  s = s.replace(/^\*\./, '').replace(/^\.+/, '') // leading *. or .
  return s
}

function apexDomain(host: string): string {
  const parts = host.split('.')
  return parts.length >= 2 ? parts.slice(-2).join('.') : host
}

function subdomainLabels(host: string): string[] {
  const parts = host.split('.')
  return parts.length > 2 ? parts.slice(0, -2) : []
}

// Labels worth entropy-screening for DGA/random hostnames: every subdomain label
// plus the registrable (second-level) label — i.e. all labels except the public
// TLD. Deduped, order preserved. For `a.b.example.com` → [a, b, example]; for a
// bare `kq3v9z7x1p2m4.com` → [kq3v9z7x1p2m4].
function entropyLabels(host: string): string[] {
  const parts = host.split('.')
  const labels = subdomainLabels(host)
  if (parts.length >= 2) {
    const registrable = parts[parts.length - 2]
    if (!labels.includes(registrable)) labels.push(registrable)
  }
  return labels
}
