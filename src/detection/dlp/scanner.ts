import { DLPConfig, DlpFinding } from '../../types.js'
import { calculateEntropy } from '../normalize.js'
import {
  DLP_RULES,
  CREDIT_CARD_CANDIDATE,
  CREDIT_CARD_MARKER,
  GENERIC_SECRET_MARKER,
  BEARER_TOKEN_MARKER,
  luhnValid,
} from './patterns.js'

// Keywords that, when immediately preceding a high-entropy token, mark it as a
// generic secret (Strategy 2). Matched case-insensitively. Covers assignment
// styles (`key=value`, `key: value`) for a broad set of credential-ish names.
const SECRET_KEYWORDS = /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|authorization|credentials?|key)\s*[:=]\s*["']?([^\s"',}]{20,})/gi

// Bearer tokens appear as `Authorization: Bearer <token>` / `Bearer <token>`
// with a SPACE separator, which the assignment pattern above does not catch.
// The `Bearer` keyword is itself a strong signal, so (unlike the generic
// keyword pattern) no entropy gate is required — only a length floor.
const BEARER_TOKEN = /\bbearer\s+([A-Za-z0-9._~+/=-]{20,})/gi

const ENTROPY_THRESHOLD = 4.0

// luhnValid used internally

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

      // Bearer tokens (space-separated, no entropy gate — keyword is the signal).
      BEARER_TOKEN.lastIndex = 0
      let b: RegExpExecArray | null
      while ((b = BEARER_TOKEN.exec(text)) !== null) {
        const value = b[1]
        if (value && value.length >= 20) {
          findings.push({
            type: 'BEARER_TOKEN',
            label: 'Bearer Token',
            match: value,
            index: b.index + b[0].indexOf(value),
          })
        }
        if (b.index === BEARER_TOKEN.lastIndex) BEARER_TOKEN.lastIndex++
      }
    }

    return findings
  }

  /**
   * Replace each matched secret with its redaction marker AT ITS EXACT LOCATION
   * (index + length), not via a global string replace. This prevents a secret
   * that coincidentally appears elsewhere (e.g. a 20-char token that also shows
   * up inside a benign URL or id) from being redacted by accident. Operates
   * directly on the raw string (no JSON.parse/stringify) so escaping in the
   * surrounding JSON is preserved and the result stays valid JSON.
   */
  redact(text: string, findings: DlpFinding[]): string {
    // Keep only findings whose recorded index still matches the text, then
    // sort by start. (A scanner finding always has a valid index, but guard so
    // hand-built/empty findings can't corrupt offsets.)
    const ranges = findings
      .filter(f =>
        f.match.length > 0 &&
        f.index >= 0 &&
        f.index + f.match.length <= text.length &&
        text.slice(f.index, f.index + f.match.length) === f.match
      )
      .map(f => ({ start: f.index, end: f.index + f.match.length, marker: markerFor(f.type) }))
      .sort((a, b) => a.start - b.start || b.end - a.end)

    // Drop any range overlapping one already kept (longest/earliest wins).
    const kept: { start: number; end: number; marker: string }[] = []
    let lastEnd = -1
    for (const r of ranges) {
      if (r.start >= lastEnd) {
        kept.push(r)
        lastEnd = r.end
      }
    }

    // Apply right-to-left so earlier indices stay valid as we splice.
    let result = text
    for (let i = kept.length - 1; i >= 0; i--) {
      const r = kept[i]!
      result = result.slice(0, r.start) + r.marker + result.slice(r.end)
    }
    return result
  }
}

function markerFor(type: string): string {
  const rule = DLP_RULES.find(r => r.type === type)
  if (rule) return rule.marker
  if (type === 'CREDIT_CARD') return CREDIT_CARD_MARKER
  if (type === 'GENERIC_SECRET') return GENERIC_SECRET_MARKER
  if (type === 'BEARER_TOKEN') return BEARER_TOKEN_MARKER
  return '[REDACTED]'
}

export { markerFor }
