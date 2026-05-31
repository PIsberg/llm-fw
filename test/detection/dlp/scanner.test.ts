import { describe, it, expect } from 'vitest'
import { DlpScanner, markerFor } from '../../../src/detection/dlp/scanner.js'
import { luhnValid, DLP_RULES } from '../../../src/detection/dlp/patterns.js'
import { DLPConfig } from '../../../src/types.js'

const ALL_DETECTORS = ['aws', 'github', 'slack', 'stripe', 'private_keys', 'mongodb', 'entropy', 'pii']

function makeScanner(detectors: string[] = ALL_DETECTORS, mode: DLPConfig['mode'] = 'redact'): DlpScanner {
  return new DlpScanner({ enabled: true, mode, detectors })
}

// Real, well-formed sample values (synthetic — not live secrets).
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const GH_TOKEN = 'ghp_' + 'a'.repeat(36)
const GHO_TOKEN = 'gho_' + 'b'.repeat(36)
const SLACK_TOKEN = 'xoxb-' + '1234567890-abcdefghijklmnop'
const STRIPE_KEY = 'sk_live_' + 'a1b2c3d4e5f6g7h8i9j0k1l2'
const PRIVATE_KEY_HEADER = '-----BEGIN RSA PRIVATE KEY-----'
const OPENSSH_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----'
const MONGO_URI = 'mongodb+srv://admin:s3cretP@cluster0.abcd.mongodb.net'
const SSN = '123-45-6789'
// Valid Luhn credit card (test Visa number)
const VALID_CARD = '4111111111111111'
const INVALID_CARD = '4111111111111112'

describe('luhnValid', () => {
  it('accepts a valid card number', () => {
    expect(luhnValid(VALID_CARD)).toBe(true)
    expect(luhnValid('4242424242424242')).toBe(true)
    expect(luhnValid('5555555555554444')).toBe(true)
  })

  it('rejects an invalid card number', () => {
    expect(luhnValid(INVALID_CARD)).toBe(false)
    expect(luhnValid('1234567812345678')).toBe(false)
  })

  it('ignores separators', () => {
    expect(luhnValid('4111 1111 1111 1111')).toBe(true)
    expect(luhnValid('4111-1111-1111-1111')).toBe(true)
  })

  it('rejects too-short or empty input', () => {
    expect(luhnValid('')).toBe(false)
    expect(luhnValid('4111')).toBe(false)
    expect(luhnValid('abcd')).toBe(false)
  })

  it('rejects too-long input', () => {
    expect(luhnValid('4'.repeat(25))).toBe(false)
  })
})

describe('DlpScanner.scan — high-confidence detectors', () => {
  const scanner = makeScanner()

  it('detects AWS access key (positive)', () => {
    const f = scanner.scan('here is my key ' + AWS_KEY + ' ok')
    expect(f.some(x => x.type === 'AWS_ACCESS_KEY' && x.match === AWS_KEY)).toBe(true)
  })

  it('does not flag a non-AWS string (negative)', () => {
    const f = scanner.scan('AKIASHORT and akialowercase1234567')
    expect(f.some(x => x.type === 'AWS_ACCESS_KEY')).toBe(false)
  })

  it('detects GitHub tokens ghp_ and gho_ (positive)', () => {
    expect(scanner.scan(GH_TOKEN).some(x => x.type === 'GITHUB_TOKEN')).toBe(true)
    expect(scanner.scan(GHO_TOKEN).some(x => x.type === 'GITHUB_TOKEN')).toBe(true)
  })

  it('does not flag a short github-like prefix (negative)', () => {
    expect(scanner.scan('ghp_short').some(x => x.type === 'GITHUB_TOKEN')).toBe(false)
  })

  it('detects Slack token (positive)', () => {
    expect(scanner.scan(SLACK_TOKEN).some(x => x.type === 'SLACK_TOKEN')).toBe(true)
  })

  it('does not flag a non-slack string (negative)', () => {
    expect(scanner.scan('xoxz-nope').some(x => x.type === 'SLACK_TOKEN')).toBe(false)
  })

  it('detects Stripe live key (positive)', () => {
    expect(scanner.scan(STRIPE_KEY).some(x => x.type === 'STRIPE_LIVE_KEY')).toBe(true)
  })

  it('does not flag stripe test key (negative)', () => {
    expect(scanner.scan('sk_test_abc123').some(x => x.type === 'STRIPE_LIVE_KEY')).toBe(false)
  })

  it('detects private key headers (RSA + OPENSSH) (positive)', () => {
    expect(scanner.scan(PRIVATE_KEY_HEADER).some(x => x.type === 'PRIVATE_KEY')).toBe(true)
    expect(scanner.scan(OPENSSH_HEADER).some(x => x.type === 'PRIVATE_KEY')).toBe(true)
  })

  it('does not flag a public key header (negative)', () => {
    expect(scanner.scan('-----BEGIN PUBLIC KEY-----').some(x => x.type === 'PRIVATE_KEY')).toBe(false)
  })

  it('detects MongoDB SRV URI (positive)', () => {
    expect(scanner.scan(MONGO_URI).some(x => x.type === 'MONGODB_URI')).toBe(true)
  })

  it('does not flag a plain mongodb:// uri without creds (negative)', () => {
    expect(scanner.scan('mongodb://localhost:27017').some(x => x.type === 'MONGODB_URI')).toBe(false)
  })

  it('detects SSN (positive)', () => {
    expect(scanner.scan('ssn ' + SSN).some(x => x.type === 'SSN')).toBe(true)
  })

  it('does not flag a malformed SSN (negative)', () => {
    expect(scanner.scan('1234-56-789').some(x => x.type === 'SSN')).toBe(false)
  })

  it('returns the correct match index', () => {
    const text = 'prefix ' + AWS_KEY
    const f = scanner.scan(text)
    const aws = f.find(x => x.type === 'AWS_ACCESS_KEY')!
    expect(text.slice(aws.index, aws.index + aws.match.length)).toBe(AWS_KEY)
  })

  it('returns empty for empty input', () => {
    expect(scanner.scan('')).toEqual([])
  })

  it('finds multiple occurrences of the same rule', () => {
    const f = scanner.scan(AWS_KEY + ' and ' + 'AKIAIOSFODNN7EXAMPL2')
    expect(f.filter(x => x.type === 'AWS_ACCESS_KEY').length).toBe(2)
  })
})

describe('DlpScanner.scan — credit cards (Luhn)', () => {
  const scanner = makeScanner()

  it('flags a Luhn-valid card', () => {
    expect(scanner.scan('card ' + VALID_CARD).some(x => x.type === 'CREDIT_CARD')).toBe(true)
  })

  it('does not flag a Luhn-invalid number', () => {
    expect(scanner.scan('num ' + INVALID_CARD).some(x => x.type === 'CREDIT_CARD')).toBe(false)
  })

  it('flags a spaced card number', () => {
    expect(scanner.scan('4111 1111 1111 1111').some(x => x.type === 'CREDIT_CARD')).toBe(true)
  })
})

describe('DlpScanner.scan — entropy generic secret (Strategy 2)', () => {
  it('flags a high-entropy token adjacent to a keyword', () => {
    const scanner = makeScanner()
    const secret = 'aZ9x7Qw2Lk8Pm3Vn6Rt1Yb4Hs0'
    const f = scanner.scan('password=' + secret)
    const g = f.find(x => x.type === 'GENERIC_SECRET')
    expect(g).toBeDefined()
    expect(g!.match).toBe(secret)
  })

  it('flags token after token= and api_key= keywords', () => {
    const scanner = makeScanner()
    expect(scanner.scan('token=aZ9x7Qw2Lk8Pm3Vn6Rt1Yb4Hs0').some(x => x.type === 'GENERIC_SECRET')).toBe(true)
    expect(scanner.scan('api_key: zXc8Vb7Nm5Lk3Jh1Gf9Ds6Aq2').some(x => x.type === 'GENERIC_SECRET')).toBe(true)
  })

  it('does not flag a low-entropy long string', () => {
    const scanner = makeScanner()
    expect(scanner.scan('password=aaaaaaaaaaaaaaaaaaaaaaaaaa').some(x => x.type === 'GENERIC_SECRET')).toBe(false)
  })

  it('does not flag a short value even with keyword', () => {
    const scanner = makeScanner()
    expect(scanner.scan('password=short').some(x => x.type === 'GENERIC_SECRET')).toBe(false)
  })

  it('does not run entropy detector when not in detectors', () => {
    const scanner = makeScanner(['aws'])
    expect(scanner.scan('password=aZ9x7Qw2Lk8Pm3Vn6Rt1Yb4Hs0').some(x => x.type === 'GENERIC_SECRET')).toBe(false)
  })
})

describe('DlpScanner.scan — detector filtering', () => {
  it('only runs detectors listed in config', () => {
    const scanner = makeScanner(['github'])
    const text = AWS_KEY + ' ' + GH_TOKEN + ' ' + SSN
    const f = scanner.scan(text)
    expect(f.some(x => x.type === 'GITHUB_TOKEN')).toBe(true)
    expect(f.some(x => x.type === 'AWS_ACCESS_KEY')).toBe(false)
    expect(f.some(x => x.type === 'SSN')).toBe(false)
  })

  it('skips credit-card scan when pii not active', () => {
    const scanner = makeScanner(['aws'])
    expect(scanner.scan(VALID_CARD).some(x => x.type === 'CREDIT_CARD')).toBe(false)
  })
})

describe('DlpScanner.redact', () => {
  const scanner = makeScanner()

  it('replaces the secret with its marker and keeps JSON valid', () => {
    const json = JSON.stringify({ messages: [{ role: 'user', content: 'my key is ' + GH_TOKEN }] })
    const findings = scanner.scan(json)
    const redacted = scanner.redact(json, findings)
    expect(redacted).not.toContain(GH_TOKEN)
    expect(redacted).toContain('[REDACTED_GITHUB_TOKEN]')
    // Surrounding JSON remains parseable.
    const parsed = JSON.parse(redacted)
    expect(parsed.messages[0].content).toContain('[REDACTED_GITHUB_TOKEN]')
    expect(parsed.messages[0].content).toContain('my key is ')
  })

  it('leaves non-secret text untouched', () => {
    const text = 'hello world no secrets here'
    expect(scanner.redact(text, scanner.scan(text))).toBe(text)
  })

  it('redacts multiple finding types', () => {
    const text = 'aws=' + AWS_KEY + ' ssn=' + SSN
    const redacted = scanner.redact(text, scanner.scan(text))
    expect(redacted).toContain('[REDACTED_AWS_KEY]')
    expect(redacted).toContain('[REDACTED_SSN]')
    expect(redacted).not.toContain(AWS_KEY)
    expect(redacted).not.toContain(SSN)
  })

  it('uses the credit-card and generic-secret markers', () => {
    const t1 = 'card ' + VALID_CARD
    expect(scanner.redact(t1, scanner.scan(t1))).toContain('[REDACTED_CREDIT_CARD]')
    const t2 = 'password=aZ9x7Qw2Lk8Pm3Vn6Rt1Yb4Hs0'
    expect(scanner.redact(t2, scanner.scan(t2))).toContain('[REDACTED_SECRET]')
  })

  it('handles findings with empty match gracefully', () => {
    expect(scanner.redact('text', [{ type: 'AWS_ACCESS_KEY', label: 'x', match: '', index: 0 }])).toBe('text')
  })
})

describe('markerFor', () => {
  it('returns the rule marker for a known type', () => {
    for (const rule of DLP_RULES) {
      expect(markerFor(rule.type)).toBe(rule.marker)
    }
  })

  it('returns special markers for CREDIT_CARD and GENERIC_SECRET', () => {
    expect(markerFor('CREDIT_CARD')).toBe('[REDACTED_CREDIT_CARD]')
    expect(markerFor('GENERIC_SECRET')).toBe('[REDACTED_SECRET]')
  })

  it('falls back to a generic marker for unknown types', () => {
    expect(markerFor('UNKNOWN')).toBe('[REDACTED]')
  })
})
