import { describe, it, expect } from 'vitest'
import { DlpScanner, markerFor } from '../../../src/detection/dlp/scanner.js'
import { luhnValid, DLP_RULES } from '../../../src/detection/dlp/patterns.js'
import { DLPConfig } from '../../../src/types.js'
import { PLAYGROUND_EXAMPLES } from '../../../src/dashboard/playgroundExamples.js'

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
import { SYNTHETIC_AWS_KEY, SYNTHETIC_AWS_STS_KEY, SYNTHETIC_AWS_SECRET, SYNTHETIC_AWS_KEY_EXAMPLE_MIDDLE } from '../../fixtures/syntheticSecrets.js'
const AWS_KEY = SYNTHETIC_AWS_KEY
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

  // One in ten numbers passes Luhn by chance, so measured over 10,000 each,
  // 997 epoch-millisecond timestamps and 974 nineteen-digit message ids were
  // rewritten to [REDACTED_CREDIT_CARD] in the JSON an agent reads back. All
  // of them start with 1; every card network's numbers start with 2 to 6.
  it('does not take a timestamp or a message id for a card', () => {
    for (const json of [
      '{"created_at": 1760054400005, "status": "ok"}',                // epoch ms
      '{"ts": 1728561234567006}',                                     // epoch microseconds
      '{"id": "1290000000000000006", "channel_id": "1290000000000000014"}', // snowflake ids
    ]) {
      expect(scanner.scan(json).some(x => x.type === 'CREDIT_CARD'), json).toBe(false)
    }
  })

  it('still flags the major card networks', () => {
    for (const card of [
      '4111111111111111',   // Visa
      '5555555555554444',   // Mastercard
      '2223003122003222',   // Mastercard 2-series
      '378282246310005',    // American Express
      '6011111111111117',   // Discover
      '3530111333300000',   // JCB
      '6200000000000005',   // UnionPay
    ]) {
      expect(scanner.scan(`card ${card}`).some(x => x.type === 'CREDIT_CARD'), card).toBe(true)
    }
  })

  // A number typed in another script's digits is the same card. Found by the
  // playground's DLP example translated into Assamese, which writes
  // "৪১১১ ১১১১ ১১১১ ১১১১" and passed.
  it('flags a card written in non-Latin digits, and redacts it in place', () => {
    for (const text of [
      'কাৰ্ড ৪১১১ ১১১১ ১১১১ ১১১১ চাৰ্জ কৰক',        // Bengali-Assamese
      'कार्ड ४१११ ११११ ११११ ११११ से भुगतान',          // Devanagari
      'البطاقة ٤١١١١١١١١١١١١١١١ من فضلك',            // Arabic-Indic
      'ꯀꯥꯔꯗ ꯴꯱꯱꯱ ꯱꯱꯱꯱ ꯱꯱꯱꯱ ꯱꯱꯱꯱',                  // Meetei Mayek
    ]) {
      const f = scanner.scan(text).filter(x => x.type === 'CREDIT_CARD')
      expect(f, text).toHaveLength(1)
      const red = scanner.redact(text, f)
      expect(red, text).toContain('[REDACTED_CREDIT_CARD]')
      expect(/[\p{Nd}]{4}/u.test(red), red).toBe(false)
    }
  })

  it('still applies Luhn and the issuer digit to non-Latin digits', () => {
    expect(scanner.scan('৪১১১১১১১১১১১১১১২').some(x => x.type === 'CREDIT_CARD')).toBe(false) // 4111...2, Luhn-invalid
    expect(scanner.scan('١٧٦٠٠٥٤٤٠٠٠٠٥').some(x => x.type === 'CREDIT_CARD')).toBe(false)    // starts with 1: a timestamp
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

  // #374: the scan runs on the raw body, where a quote inside a JSON string
  // is the two characters \". A value ending at that quote must not take its
  // backslash with it, or the redacted body no longer parses.
  it('keeps a JSON body valid when a generic secret ends at an escaped quote or newline', () => {
    const secret = 'aZ9x7Qw2Lk8Pm3Vn6Rt1Yb4Hs0'
    for (const content of [`run(["deploy", "--token=${secret}"])`, `password=${secret}" >> .env`, `token=${secret}\nnext line`]) {
      const json = JSON.stringify({ messages: [{ role: 'user', content }] })
      const redacted = scanner.redact(json, scanner.scan(json))
      expect(() => JSON.parse(redacted), content).not.toThrow()
      expect(redacted).not.toContain(secret)
      expect(JSON.parse(redacted).messages[0].content).toContain('[REDACTED_SECRET]')
    }
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
    { type: 'AWS_ACCESS_KEY', key: SYNTHETIC_AWS_STS_KEY }, // temporary/STS id
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
    const secret = SYNTHETIC_AWS_SECRET // synthetic 40-char secret (AWS's own example ends in EXAMPLEKEY and is exempt)
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

describe('vendor-documented example credentials', () => {
  // Published BY the vendor as examples, so not credentials. Redacting them is
  // the worst-shaped false positive this stage has, because it is silent: in
  // the default `redact` mode nothing blocks and nothing warns, the prompt is
  // just rewritten, and the user only sees that the model stopped making
  // sense. It never appears in the FPR gate either, which counts blocks.
  //
  // The suite's own AWS_KEY fixture used to BE AWS's documented example key.
  // It is now a synthetic key, precisely so that "detected" and "exempt" are
  // testable as different things.
  const AWS_DOC_KEY = 'AKIAIOSFODNN7EXAMPLE'
  const AWS_DOC_KEY_2 = 'AKIAI44QH8DHBEXAMPLE'
  const AWS_DOC_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

  it('leaves the AWS documentation key alone', () => {
    const scanner = makeScanner()
    const text = `The AWS docs use ${AWS_DOC_KEY} as the sample access key id. Should our fixtures use that, or a random string?`

    expect(scanner.scan(text)).toHaveLength(0)
  })

  it('passes the question through to the model unchanged', () => {
    // The whole point: the model has to see the actual string to answer it.
    const scanner = makeScanner()
    const text = `Is it safe to commit ${AWS_DOC_KEY} in a test fixture?`

    expect(scanner.redact(text, scanner.scan(text))).toBe(text)
  })

  it('covers the other documented key and the paired secret', () => {
    const scanner = makeScanner()

    expect(scanner.scan(`key ${AWS_DOC_KEY_2}`)).toHaveLength(0)
    expect(scanner.scan(`secret ${AWS_DOC_SECRET}`)).toHaveLength(0)
  })

  it('still redacts a real key in a sentence that talks about examples', () => {
    // The exemption is the EXAMPLE suffix, not the word appearing nearby.
    const scanner = makeScanner()
    const text = `For example, deploy with ${AWS_KEY} and restart.`
    const findings = scanner.scan(text)

    expect(findings).toHaveLength(1)
    expect(scanner.redact(text, findings)).not.toContain(AWS_KEY)
  })

  it('does not exempt a key that merely contains EXAMPLE mid-string', () => {
    const scanner = makeScanner()

    expect(scanner.scan(SYNTHETIC_AWS_KEY_EXAMPLE_MIDDLE)).toHaveLength(1)
  })
})

// GHSA-3hx2-682q-w4gw. The private_keys rule matched only the BEGIN line, so
// redact mode replaced the header and forwarded the key body and the END line
// to the provider; encrypted PKCS#8 and PGP private keys were not found at
// all. The whole block, header through END, is the secret. Key text is built
// at runtime so this file carries no literal PEM block.
describe('DlpScanner.redact — the whole private key block', () => {
  const scanner = makeScanner()
  const DASHES = '-----'
  const begin = (label: string): string => `${DASHES}BEGIN ${label}${DASHES}`
  const end = (label: string): string => `${DASHES}END ${label}${DASHES}`
  // 64-character base64 lines, as PEM writes them, and a short last line.
  const BODY_LINES = Array.from({ length: 5 }, (_, i) =>
    Array.from({ length: 64 }, (_, j) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[(i * 131 + j * 17) % 64]).join(''),
  ).concat(['q8Zk3RmW0x=='])
  const block = (label: string, headers: string[] = [], eol = '\n'): string =>
    [begin(label), ...headers, ...BODY_LINES, end(label)].join(eol)
  const leaked = (out: string): string[] =>
    [...BODY_LINES, DASHES + 'END'].filter((part) => out.includes(part))

  // A raw request body: the scan runs on it before JSON parsing, so the key's
  // line breaks are the two characters `\n`.
  const roundTrip = (content: string): { raw: string; content: string } => {
    const body = JSON.stringify({ messages: [{ role: 'user', content }] })
    const raw = scanner.redact(body, scanner.scan(body))
    return { raw, content: (JSON.parse(raw) as { messages: { content: string }[] }).messages[0]!.content }
  }

  it.each([
    'RSA PRIVATE KEY',
    'PRIVATE KEY',
    'EC PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'DSA PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
  ])('redacts a %s block from its header through END in a JSON body', (label) => {
    const { raw, content } = roundTrip(`Deploy with this:\n${block(label)}\nand tell me if it works.`)
    expect(leaked(raw)).toEqual([])
    expect(content).toBe('Deploy with this:\n[REDACTED_PRIVATE_KEY]\nand tell me if it works.')
  })

  it('redacts a PGP private key block with its armor headers, blank line and checksum', () => {
    const pgp = [begin('PGP PRIVATE KEY BLOCK'), 'Version: GnuPG v2', 'Comment: work laptop', '', ...BODY_LINES, '=Xb4d', end('PGP PRIVATE KEY BLOCK')].join('\n')
    const { raw, content } = roundTrip(`key:\n${pgp}\ndone`)
    expect(leaked(raw)).toEqual([])
    expect(raw).not.toContain('GnuPG')
    expect(content).toBe('key:\n[REDACTED_PRIVATE_KEY]\ndone')
  })

  it('redacts a traditionally encrypted PEM with Proc-Type and DEK-Info headers', () => {
    const { raw, content } = roundTrip(block('RSA PRIVATE KEY', ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,9F3C1A2B4D5E6F708192A3B4C5D6E7F8', '']))
    expect(leaked(raw)).toEqual([])
    expect(raw).not.toContain('DEK-Info')
    expect(content).toBe('[REDACTED_PRIVATE_KEY]')
  })

  it('redacts a block with real line breaks, CRLF, or flattened onto one line', () => {
    for (const text of [block('RSA PRIVATE KEY'), block('RSA PRIVATE KEY', [], '\r\n'), block('RSA PRIVATE KEY', [], ' ')]) {
      const out = scanner.redact(`before ${text} after`, scanner.scan(`before ${text} after`))
      expect(leaked(out)).toEqual([])
      expect(out).toBe('before [REDACTED_PRIVATE_KEY] after')
    }
  })

  it('redacts a key inside a tool result that was itself JSON-encoded', () => {
    const inner = JSON.stringify({ path: 'id_rsa', text: block('OPENSSH PRIVATE KEY') })
    const { raw, content } = roundTrip(inner)
    expect(leaked(raw)).toEqual([])
    expect(JSON.parse(content)).toEqual({ path: 'id_rsa', text: '[REDACTED_PRIVATE_KEY]' })
  })

  it('redacts a block from an encoder that writes / as \\/', () => {
    const raw = JSON.stringify({ content: block('RSA PRIVATE KEY') }).replaceAll('/', '\\/')
    const out = scanner.redact(raw, scanner.scan(raw))
    expect(out).not.toContain('END')
    expect(JSON.parse(out)).toEqual({ content: '[REDACTED_PRIVATE_KEY]' })
  })

  it('redacts every block when one body carries two keys, and keeps the text between', () => {
    const { raw, content } = roundTrip(`${block('EC PRIVATE KEY')}\nsecond one:\n${block('PRIVATE KEY')}`)
    expect(leaked(raw)).toEqual([])
    expect(content).toBe('[REDACTED_PRIVATE_KEY]\nsecond one:\n[REDACTED_PRIVATE_KEY]')
  })

  it('redacts the key lines of a truncated paste with no END line, and stops at prose', () => {
    const truncated = [begin('RSA PRIVATE KEY'), ...BODY_LINES.slice(0, 3)].join('\n')
    const { raw, content } = roundTrip(`${truncated}\nIs this the right format?`)
    expect(BODY_LINES.slice(0, 3).filter((l) => raw.includes(l))).toEqual([])
    expect(content).toBe('[REDACTED_PRIVATE_KEY]\nIs this the right format?')
  })

  it("redacts the dashboard playground's private-key example down to its ellipsis", () => {
    // The playground shows this redaction to the user; a body fragment left
    // after the marker is how the leak was found.
    const example = PLAYGROUND_EXAMPLES.dlp!.find((e) => e.label === 'Private key')!.value
    expect(roundTrip(example).content).toBe('Here is the deploy key:\n[REDACTED_PRIVATE_KEY]...')
  })

  it('leaves public keys and certificates alone', () => {
    for (const label of ['PUBLIC KEY', 'CERTIFICATE', 'PGP PUBLIC KEY BLOCK']) {
      expect(scanner.scan(block(label)).filter((f) => f.type === 'PRIVATE_KEY')).toEqual([])
    }
  })

  it('still finds a bare header, and block mode still sees the key', () => {
    expect(scanner.scan(begin('RSA PRIVATE KEY')).map((f) => f.type)).toContain('PRIVATE_KEY')
    expect(makeScanner(ALL_DETECTORS, 'block').scan(block('ENCRYPTED PRIVATE KEY')).map((f) => f.type)).toContain('PRIVATE_KEY')
  })

  // DLP runs on the request thread over attacker-reachable text (tool results),
  // so the block extension must stay linear: no header may rescan the rest of
  // the body looking for an END line.
  describe('linear time on large bodies', () => {
    const KB200 = 200 * 1024
    const fill = (unit: string): string => unit.repeat(Math.ceil(KB200 / unit.length)).slice(0, KB200)
    it.each([
      ['headers with no END line', () => fill(begin('RSA PRIVATE KEY') + '\\n')],
      ['one header then a base64 run', () => begin('PRIVATE KEY') + fill('A')],
      ['one header then escaped line breaks', () => begin('PRIVATE KEY') + fill('\\n')],
      ['one header then whitespace', () => begin('PRIVATE KEY') + fill(' \n')],
      ['header and armor-looking lines', () => fill(begin('PGP PRIVATE KEY BLOCK') + '\nVersion: x\n')],
      ['a dash-separated run', () => begin('PRIVATE KEY') + fill('1-')],
      ['near-miss END lines', () => begin('PRIVATE KEY') + fill('AAAA\\n----END ')],
      ['one header then a run of backslashes', () => begin('PRIVATE KEY') + ' ' + fill('\\')],
      ['one header then one long escape', () => begin('PRIVATE KEY') + ' ' + fill('\\').slice(1) + 't'],
      ['headers then long backslash runs', () => fill(begin('PRIVATE KEY') + ' ' + '\\'.repeat(5000) + 'n')],
    ])('scans and redacts 200 KB of %s in under 1.5 s', (_label, make) => {
      const text = make()
      const t0 = performance.now()
      scanner.redact(text, scanner.scan(text))
      expect(performance.now() - t0).toBeLessThan(1500)
    })
  })
})
