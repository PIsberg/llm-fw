import { UrlFilterConfig } from '../types.js'
import { calculateEntropy } from './normalize.js'

export interface UrlClassifyResult {
  action: 'block' | 'pass';
  reason: string;
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
    this.allowlist = new Set(config.allowlistDomains.map(d => d.toLowerCase()))
    this.blocklist = new Set(config.blocklistDomains.map(d => d.toLowerCase()))
    this.entropyThreshold = config.entropyThreshold
  }

  classify(hostname: string, path?: string): UrlClassifyResult {
    const host = hostname.toLowerCase()

    if (this.matchesList(host, this.allowlist)) return { action: 'pass', reason: 'allowlisted' }
    if (this.matchesList(host, this.blocklist)) return { action: 'block', reason: 'domain-blocklisted' }

    const apex = apexDomain(host)
    if (KNOWN_EXFIL_DOMAINS.has(apex)) return { action: 'block', reason: 'known-exfil-domain' }

    for (const label of subdomainLabels(host)) {
      if (DNS_TUNNEL_LABELS.test(label)) return { action: 'block', reason: 'dns-tunnel-label' }
      if (label.length >= 12) {
        const e = calculateEntropy(label)
        if (e >= this.entropyThreshold) {
          return { action: 'block', reason: `high-entropy-subdomain:${label.slice(0, 20)}` }
        }
      }
    }

    if (path) {
      for (const pattern of EXFIL_PATH_PATTERNS) {
        if (pattern.test(path)) return { action: 'block', reason: 'query-exfil-pattern' }
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

function apexDomain(host: string): string {
  const parts = host.split('.')
  return parts.length >= 2 ? parts.slice(-2).join('.') : host
}

function subdomainLabels(host: string): string[] {
  const parts = host.split('.')
  return parts.length > 2 ? parts.slice(0, -2) : []
}
