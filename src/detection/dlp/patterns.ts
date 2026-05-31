// High-confidence DLP detector rules. Each rule maps a credential/PII format
// to a stable `type` (used in events and config.detectors filtering), a human
// `label`, a `regex`, and a `marker` substituted in redaction mode.
//
// IMPORTANT: every regex uses the global flag so the scanner can find all
// occurrences. The scanner resets `lastIndex` between uses.

export interface DlpRule {
  // detector key matched against config.detectors (e.g. 'aws', 'github')
  detector: string
  // finding type surfaced in events (e.g. 'AWS_ACCESS_KEY')
  type: string
  label: string
  regex: RegExp
  marker: string
}

export const DLP_RULES: DlpRule[] = [
  {
    detector: 'aws',
    type: 'AWS_ACCESS_KEY',
    label: 'AWS Access Key',
    regex: /AKIA[0-9A-Z]{16}/g,
    marker: '[REDACTED_AWS_KEY]',
  },
  {
    detector: 'github',
    type: 'GITHUB_TOKEN',
    label: 'GitHub Token',
    regex: /gh[posr]_[0-9A-Za-z]{36}/g,
    marker: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    detector: 'slack',
    type: 'SLACK_TOKEN',
    label: 'Slack Token',
    regex: /xox[baprs]-[0-9A-Za-z-]{10,}/g,
    marker: '[REDACTED_SLACK_TOKEN]',
  },
  {
    detector: 'stripe',
    type: 'STRIPE_LIVE_KEY',
    label: 'Stripe Live Secret Key',
    regex: /sk_live_[0-9a-zA-Z]{24,}/g,
    marker: '[REDACTED_STRIPE_KEY]',
  },
  {
    detector: 'private_keys',
    type: 'PRIVATE_KEY',
    label: 'Private Key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    marker: '[REDACTED_PRIVATE_KEY]',
  },
  {
    detector: 'mongodb',
    type: 'MONGODB_URI',
    label: 'MongoDB SRV Connection URI',
    regex: /mongodb\+srv:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/"']+/g,
    marker: '[REDACTED_MONGODB_URI]',
  },
  {
    detector: 'pii',
    type: 'SSN',
    label: 'US Social Security Number',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    marker: '[REDACTED_SSN]',
  },
]

// Marker used for Luhn-validated credit-card candidates (PII detector).
export const CREDIT_CARD_MARKER = '[REDACTED_CREDIT_CARD]'

// Marker used for entropy-based generic secrets (Strategy 2).
export const GENERIC_SECRET_MARKER = '[REDACTED_SECRET]'

// Candidate credit-card numbers: 13–19 digits, optionally separated by single
// spaces or hyphens. Validation via Luhn happens in the scanner.
export const CREDIT_CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g

/**
 * Luhn checksum validation for a string of digits (separators allowed and
 * ignored). Returns false for input with no digits or fewer than 13 digits.
 */
export function luhnValid(digits: string): boolean {
  const cleaned = digits.replace(/[^0-9]/g, '')
  if (cleaned.length < 13 || cleaned.length > 19) return false
  let sum = 0
  let double = false
  for (let i = cleaned.length - 1; i >= 0; i--) {
    let d = cleaned.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}
