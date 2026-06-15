import { describe, it, expect } from 'vitest'
import { DlpScanner, markerFor } from '../../../src/detection/dlp/scanner.js'
import { luhnValid, DLP_RULES } from '../../../src/detection/dlp/patterns.js'
import { DLPConfig } from '../../../src/types.js'

const ALL_DETECTORS = [
  'aws', 'google', 'azure', 'digitalocean',
  'openai', 'anthropic', 'openrouter', 'groq', 'xai', 'perplexity',
  'huggingface', 'replicate', 'fireworks', 'nvidia', 'anyscale', 'langsmith',
  'github', 'gitlab', 'npm', 'pypi', 'rubygems', 'dockerhub', 'vault',
  'terraform', 'databricks', 'atlassian', 'newrelic', 'sentry',
  'stripe', 'square', 'shopify', 'slack', 'discord', 'telegram',
  'twilio', 'sendgrid', 'mailgun', 'mailchimp',
  'private_keys', 'mongodb', 'connection_uri', 'jwt', 'entropy', 'pii',
]

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

  it('every marker is JSON-safe (no quotes or backslashes)', () => {
    const types = [...DLP_RULES.map(r => r.type), 'CREDIT_CARD', 'GENERIC_SECRET', 'BEARER_TOKEN', 'UNKNOWN']
    for (const t of types) {
      const marker = markerFor(t)
      expect(marker).not.toMatch(/["'\\]/)
      // Substituting the marker into a JSON string keeps it parseable.
      expect(() => JSON.parse(JSON.stringify({ x: 'a ' + marker + ' b' }))).not.toThrow()
    }
  })
})

describe('DlpScanner.scan — Bearer tokens & expanded keywords', () => {
  it('detects an Authorization: Bearer token', () => {
    const scanner = makeScanner()
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'
    const f = scanner.scan('Authorization: Bearer ' + jwt)
    const b = f.find(x => x.type === 'BEARER_TOKEN')
    expect(b).toBeDefined()
    expect(b!.match).toBe(jwt)
  })

  it('redacts a bearer token with its dedicated marker', () => {
    const scanner = makeScanner()
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aaaaaaaa'
    const text = 'Authorization: Bearer ' + jwt
    const out = scanner.redact(text, scanner.scan(text))
    expect(out).toContain('[REDACTED_BEARER_TOKEN]')
    expect(out).not.toContain(jwt)
  })

  it('detects the expanded keyword set (pwd, auth, credential, key)', () => {
    const scanner = makeScanner()
    const v = 'aZ9x7Qw2Lk8Pm3Vn6Rt1Yb4Hs0' // high-entropy, >20 chars
    expect(scanner.scan('pwd=' + v).some(x => x.type === 'GENERIC_SECRET')).toBe(true)
    expect(scanner.scan('auth: ' + v).some(x => x.type === 'GENERIC_SECRET')).toBe(true)
    expect(scanner.scan('credential=' + v).some(x => x.type === 'GENERIC_SECRET')).toBe(true)
    expect(scanner.scan('key=' + v).some(x => x.type === 'GENERIC_SECRET')).toBe(true)
  })
})

describe('DlpScanner.scan — AI service / cloud provider API keys', () => {
  const scanner = makeScanner()

  // Synthetic, well-formed sample values (not live secrets).
  const cases: { type: string; key: string }[] = [
    { type: 'OPENAI_API_KEY', key: 'sk-' + 'a1B2c3D4'.repeat(6) }, // legacy 48-char
    { type: 'OPENAI_API_KEY', key: 'sk-proj-' + 'a1B2c3D4e5F6_g7H8-i9J0kL' },
    { type: 'OPENAI_API_KEY', key: 'sk-svcacct-' + 'A1b2C3d4E5f6G7h8I9j0K1l2' },
    { type: 'ANTHROPIC_API_KEY', key: 'sk-ant-api03-' + 'a'.repeat(40) },
    { type: 'OPENROUTER_API_KEY', key: 'sk-or-v1-' + 'a'.repeat(64) },
    { type: 'GROQ_API_KEY', key: 'gsk_' + 'a'.repeat(52) },
    { type: 'XAI_API_KEY', key: 'xai-' + 'a'.repeat(80) },
    { type: 'PERPLEXITY_API_KEY', key: 'pplx-' + 'a'.repeat(48) },
    { type: 'HUGGINGFACE_TOKEN', key: 'hf_' + 'a'.repeat(34) },
    { type: 'REPLICATE_API_KEY', key: 'r8_' + 'a'.repeat(37) },
    { type: 'FIREWORKS_API_KEY', key: 'fw_' + 'a'.repeat(24) },
    { type: 'NVIDIA_API_KEY', key: 'nvapi-' + 'a'.repeat(64) },
    { type: 'ANYSCALE_API_KEY', key: 'esecret_' + 'a'.repeat(24) },
    { type: 'LANGSMITH_API_KEY', key: 'lsv2_pt_' + 'a'.repeat(32) },
    { type: 'GOOGLE_API_KEY', key: 'AIza' + 'a'.repeat(35) },
    { type: 'GOOGLE_OAUTH_TOKEN', key: 'ya29.' + 'a'.repeat(40) },
    { type: 'AWS_ACCESS_KEY', key: 'ASIAIOSFODNN7EXAMPLE' }, // temporary/STS id
    { type: 'AWS_MWS_KEY', key: 'amzn.mws.4ea38b7b-f563-4709-4bae-87aea1234567' },
  ]

  for (const { type, key } of cases) {
    it(`detects ${type}`, () => {
      const f = scanner.scan('credential: ' + key + ' end')
      const hit = f.find(x => x.type === type)
      expect(hit, `expected a ${type} finding`).toBeDefined()
      expect(hit!.match).toBe(key)
    })
  }

  it('detects a keyword-adjacent AWS secret access key', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' // canonical 40-char example
    const f = scanner.scan('AWS_SECRET_ACCESS_KEY=' + secret)
    expect(f.some(x => x.type === 'AWS_SECRET_KEY')).toBe(true)
  })

  it('does not confuse Anthropic / OpenRouter keys with OpenAI keys', () => {
    const ant = 'sk-ant-api03-' + 'a'.repeat(40)
    const or = 'sk-or-v1-' + 'a'.repeat(64)
    expect(scanner.scan(ant).some(x => x.type === 'OPENAI_API_KEY')).toBe(false)
    expect(scanner.scan(or).some(x => x.type === 'OPENAI_API_KEY')).toBe(false)
  })

  it('does not flag short look-alike prefixes (negatives)', () => {
    const text = 'sk-short hf_short gsk_short AIzaShort ya29.short xai-short'
    const f = scanner.scan(text)
    expect(f).toHaveLength(0)
  })

  it('redacts each provider key with a JSON-safe marker', () => {
    for (const { key } of cases) {
      const json = JSON.stringify({ messages: [{ role: 'user', content: 'key ' + key }] })
      const redacted = scanner.redact(json, scanner.scan(json))
      expect(redacted, `key ${key} should be redacted`).not.toContain(key)
      expect(() => JSON.parse(redacted)).not.toThrow()
    }
  })

  it('respects detector filtering for provider keys', () => {
    const onlyOpenai = makeScanner(['openai'])
    const text = 'sk-' + 'a1B2c3D4'.repeat(6) + ' AIza' + 'a'.repeat(35)
    const f = onlyOpenai.scan(text)
    expect(f.some(x => x.type === 'OPENAI_API_KEY')).toBe(true)
    expect(f.some(x => x.type === 'GOOGLE_API_KEY')).toBe(false)
  })
})

describe('DlpScanner.scan — corporate / SaaS / infra secrets', () => {
  const scanner = makeScanner()

  // Synthetic, well-formed sample values (not live secrets). Bodies use repeated
  // chars so they satisfy each format's charset and length without tripping the
  // entropy detector.
  const cases: { type: string; key: string }[] = [
    { type: 'GITHUB_FINE_GRAINED_PAT', key: 'github_pat_' + 'a'.repeat(82) },
    { type: 'GITLAB_PAT', key: 'glpat-' + 'a'.repeat(20) },
    { type: 'NPM_TOKEN', key: 'npm_' + 'a'.repeat(36) },
    { type: 'PYPI_TOKEN', key: 'pypi-AgEI' + 'a'.repeat(50) },
    { type: 'RUBYGEMS_KEY', key: 'rubygems_' + 'a'.repeat(48) },
    { type: 'DOCKERHUB_PAT', key: 'dckr_pat_' + 'a'.repeat(24) },
    { type: 'VAULT_TOKEN', key: 'hvs.' + 'a'.repeat(24) },
    { type: 'TERRAFORM_CLOUD_TOKEN', key: 'a'.repeat(14) + '.atlasv1.' + 'a'.repeat(40) },
    { type: 'DATABRICKS_TOKEN', key: 'dapi' + 'a'.repeat(32) },
    { type: 'ATLASSIAN_API_TOKEN', key: 'ATATT3' + 'a'.repeat(100) },
    { type: 'SQUARE_TOKEN', key: 'sq0atp-' + 'a'.repeat(22) },
    { type: 'SHOPIFY_TOKEN', key: 'shpat_' + 'a'.repeat(32) },
    { type: 'TWILIO_KEY', key: 'AC' + 'a'.repeat(32) },
    { type: 'SENDGRID_KEY', key: 'SG.' + 'a'.repeat(22) + '.' + 'a'.repeat(43) },
    { type: 'MAILGUN_KEY', key: 'key-' + 'a'.repeat(32) },
    { type: 'MAILCHIMP_KEY', key: 'a'.repeat(32) + '-us5' },
    { type: 'TELEGRAM_BOT_TOKEN', key: '123456789:' + 'a'.repeat(35) },
    { type: 'DISCORD_WEBHOOK', key: 'https://discord.com/api/webhooks/123456789012345678/' + 'a'.repeat(40) },
    { type: 'DISCORD_BOT_TOKEN', key: 'M' + 'a'.repeat(23) + '.' + 'a'.repeat(6) + '.' + 'a'.repeat(27) },
    { type: 'AZURE_STORAGE_KEY', key: 'AccountKey=' + 'a'.repeat(86) + '==' },
    { type: 'DIGITALOCEAN_TOKEN', key: 'dop_v1_' + 'a'.repeat(64) },
    { type: 'NEWRELIC_KEY', key: 'NRAK-' + 'a'.repeat(27) },
    { type: 'SENTRY_DSN', key: 'https://' + 'a'.repeat(32) + '@o447951.ingest.sentry.io/12345' },
    { type: 'GITHUB_TOKEN', key: 'ghu_' + 'a'.repeat(36) }, // user-to-server, now covered
    { type: 'STRIPE_LIVE_KEY', key: 'rk_live_' + 'a'.repeat(24) }, // restricted live key
    { type: 'STRIPE_WEBHOOK_SECRET', key: 'whsec_' + 'a'.repeat(32) },
    { type: 'SLACK_WEBHOOK', key: 'https://hooks.slack.com/services/T00000000/B00000000/' + 'a'.repeat(24) },
    {
      type: 'JWT',
      key: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
    },
    { type: 'CONNECTION_URI', key: 'postgres://dbuser:s3cretPass@db.internal.example.com:5432/prod' },
  ]

  for (const { type, key } of cases) {
    it(`detects ${type}`, () => {
      const f = scanner.scan('credential: ' + key + ' end')
      expect(f.some(x => x.type === type), `expected a ${type} finding`).toBe(true)
    })
  }

  it('redacts every corporate secret and keeps JSON valid', () => {
    for (const { key } of cases) {
      const json = JSON.stringify({ messages: [{ role: 'user', content: 'value ' + key }] })
      const redacted = scanner.redact(json, scanner.scan(json))
      expect(() => JSON.parse(redacted)).not.toThrow()
      // The sensitive core must be gone (connection strings keep the trailing
      // path after the credential, so assert on the secret segment).
      const core = key.includes('@') ? key.split('@')[0] : key
      expect(redacted, `secret ${core} should be redacted`).not.toContain(core)
    }
  })

  it('does not flag a DB URI without an embedded password (negative)', () => {
    expect(scanner.scan('postgres://dbuser@db.example.com:5432/prod').some(x => x.type === 'CONNECTION_URI')).toBe(false)
  })

  it('does not flag arbitrary three-part base64 as a JWT (negative)', () => {
    // Segments do not base64url-decode to a JSON object (no eyJ prefix).
    expect(scanner.scan('abcdefghij.klmnopqrst.uvwxyz0123').some(x => x.type === 'JWT')).toBe(false)
  })
})

describe('DlpScanner.redact — exact-location replacement', () => {
  it('redacts a secret only where it was matched, not coincidental copies', () => {
    const scanner = makeScanner()
    const secret = 'Xy7Qw2Lk8Pm3Vn6Rt1Yb4' // 22 chars, high entropy
    // The same string also appears later as a benign path segment (no keyword),
    // so the scanner records exactly ONE finding (the keyword-adjacent one).
    const text = 'password=' + secret + ' see https://ex.com/' + secret
    const findings = scanner.scan(text)
    expect(findings.filter(f => f.type === 'GENERIC_SECRET')).toHaveLength(1)
    const redacted = scanner.redact(text, findings)
    expect(redacted).toContain('password=[REDACTED_SECRET]')
    // The coincidental copy survives — only the matched location is redacted.
    expect(redacted).toContain('https://ex.com/' + secret)
  })

  it('redacts all genuine occurrences when each is independently matched', () => {
    const scanner = makeScanner()
    const text = AWS_KEY + ' and again ' + AWS_KEY
    const redacted = scanner.redact(text, scanner.scan(text))
    expect(redacted).not.toContain(AWS_KEY)
    expect(redacted.match(/\[REDACTED_AWS_KEY\]/g)!).toHaveLength(2)
  })
})
