import { DLPConfig, DlpFinding } from '../../types.js'
import { calculateEntropy } from '../normalize.js'
import {
  DLP_RULES,
  CREDIT_CARD_CANDIDATE,
  CREDIT_CARD_MARKER,
  GENERIC_SECRET_MARKER,
  luhnValid,
} from './patterns.js'

// Keywords that, when immediately preceding a high-entropy token, mark it as a
// generic secret (Strategy 2). Matched case-insensitively.
const SECRET_KEYWORDS = /(password|secret|token|api_key|apikey)\s*[=:]\s*["']?([^\s"',}]{20,})/gi

const ENTROPY_THRESHOLD = 4.0

export { luhnValid }

export class DlpScanner {
  private config: DLPConfig

  constructor(config: DLPConfig) {
    this.config = config
  }

  private active(detector: string): boolean {
    return this.config.detectors.includes(detector)
  }

  /**
   * Scan raw text for secrets and PII. Returns one finding per match. Operates
   * on the raw request string so that redaction can replace the exact matched
   * substrings without disturbing surrounding JSON escaping.
   */
  scan(text: string): DlpFinding[] {
    const findings: DlpFinding[] = []
    if (!text) return findings

    // Strategy 1 + PII (regex-based high-confidence rules)
    for (const rule of DLP_RULES) {
      if (!this.active(rule.detector)) continue
      rule.regex.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = rule.regex.exec(text)) !== null) {
        findings.push({ type: rule.type, label: rule.label, match: m[0], index: m.index })
        if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++
      }
    }

    // PII: credit-card candidates validated with the Luhn algorithm.
    if (this.active('pii')) {
      CREDIT_CARD_CANDIDATE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = CREDIT_CARD_CANDIDATE.exec(text)) !== null) {
        if (luhnValid(m[0])) {
          findings.push({ type: 'CREDIT_CARD', label: 'Credit Card Number', match: m[0], index: m.index })
        }
        if (m.index === CREDIT_CARD_CANDIDATE.lastIndex) CREDIT_CARD_CANDIDATE.lastIndex++
      }
    }

    // Strategy 2: entropy-based generic-secret detection.
    if (this.active('entropy')) {
      SECRET_KEYWORDS.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = SECRET_KEYWORDS.exec(text)) !== null) {
        const value = m[2]
        if (value && value.length > 20 && calculateEntropy(value) > ENTROPY_THRESHOLD) {
          findings.push({
            type: 'GENERIC_SECRET',
            label: 'High-Entropy Generic Secret',
            match: value,
            // index of the secret value itself, not the leading keyword
            index: m.index + m[0].indexOf(value),
          })
        }
        if (m.index === SECRET_KEYWORDS.lastIndex) SECRET_KEYWORDS.lastIndex++
      }
    }

    return findings
  }

  /**
   * Replace each matched secret substring with its redaction marker. Operates
   * directly on the raw string (no JSON.parse/stringify) so escaping in the
   * surrounding JSON is preserved and the result stays valid JSON.
   */
  redact(text: string, findings: DlpFinding[]): string {
    let result = text
    // Replace longest matches first to avoid partial-overlap corruption, and
    // deduplicate identical secret substrings.
    const seen = new Set<string>()
    const ordered = [...findings].sort((a, b) => b.match.length - a.match.length)
    for (const f of ordered) {
      if (!f.match || seen.has(f.match)) continue
      seen.add(f.match)
      result = result.split(f.match).join(markerFor(f.type))
    }
    return result
  }
}

function markerFor(type: string): string {
  const rule = DLP_RULES.find(r => r.type === type)
  if (rule) return rule.marker
  if (type === 'CREDIT_CARD') return CREDIT_CARD_MARKER
  if (type === 'GENERIC_SECRET') return GENERIC_SECRET_MARKER
  return '[REDACTED]'
}

export { markerFor }
