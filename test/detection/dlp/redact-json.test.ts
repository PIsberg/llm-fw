import { describe, it, expect } from 'vitest'
import { DlpScanner } from '../../../src/detection/dlp/scanner.js'
import { SYNTHETIC_AWS_SECRET } from '../../fixtures/syntheticSecrets.js'

// #915: redaction must leave a JSON body parseable, and a secret that ends in a
// base64 symbol must be found whole. A body that no longer parses is refused
// with 422 malformed-body, so a redact-mode request with an AWS secret in it
// failed outright instead of going out redacted.
const scanner = new DlpScanner({ enabled: true, mode: 'redact', detectors: ['aws', 'google', 'telegram', 'mongodb', 'connection_uri'] })
const redact = (text: string) => scanner.redact(text, scanner.scan(text))
/** The redacted body, parsed: throws when redaction broke the JSON. */
const redactJson = (value: unknown) => JSON.parse(redact(JSON.stringify(value))) as unknown

describe('#915 DLP redaction keeps JSON valid', () => {
  it('redacts only the AWS secret value, not the key and quotes around it', () => {
    expect(redactJson({ aws_secret: SYNTHETIC_AWS_SECRET })).toEqual({ aws_secret: '[REDACTED_AWS_SECRET]' })
    expect(redactJson({ config: { aws_secret_access_key: SYNTHETIC_AWS_SECRET, region: 'eu-north-1' } }))
      .toEqual({ config: { aws_secret_access_key: '[REDACTED_AWS_SECRET]', region: 'eu-north-1' } })
  })

  it('redacts the AWS secret inside a JSON string that quotes JSON', () => {
    const prompt = JSON.stringify({ aws_secret: SYNTHETIC_AWS_SECRET })
    expect(redactJson({ messages: [{ role: 'user', content: prompt }] }))
      .toEqual({ messages: [{ role: 'user', content: JSON.stringify({ aws_secret: '[REDACTED_AWS_SECRET]' }) }] })
  })

  it('records the AWS secret finding at the value', () => {
    const text = 'aws_secret = ' + SYNTHETIC_AWS_SECRET
    const [f] = scanner.scan(text).filter(x => x.type === 'AWS_SECRET_KEY')
    expect(f?.match).toBe(SYNTHETIC_AWS_SECRET)
    expect(f?.index).toBe(text.indexOf(SYNTHETIC_AWS_SECRET))
  })

  it.each(['+', '/'])('finds an AWS secret that ends in %s', (end) => {
    const secret = SYNTHETIC_AWS_SECRET.slice(0, 39) + end
    expect(redactJson({ aws_secret: secret })).toEqual({ aws_secret: '[REDACTED_AWS_SECRET]' })
    expect(redact('aws secret key: ' + secret)).toBe('aws secret key: [REDACTED_AWS_SECRET]')
  })

  it.each(['=', '==', '+', '/'])('redacts an AWS session token ending in %s whole', (end) => {
    const token = 'FwoG' + 'ZXIvYXdzEJr'.repeat(6) + end
    expect(redactJson({ token })).toEqual({ token: '[REDACTED_AWS_SESSION_TOKEN]' })
    expect(redact(token + ' rest')).toBe('[REDACTED_AWS_SESSION_TOKEN] rest')
  })

  it.each([
    ['an escaped quote', 'Connect to postgres://user:pass1@host.example.com"', 'Connect to [REDACTED_CONNECTION_URI]"'],
    ['an escaped newline', 'postgres://user:pass1@host.example.com\nnext line', '[REDACTED_CONNECTION_URI]\nnext line'],
    ['a backslash', 'url=postgres://user:pass1@host.example.com\\share', 'url=[REDACTED_CONNECTION_URI]\\share'],
    ['an escaped quote, as a MongoDB SRV URI', 'use "mongodb+srv://admin:s3cretP@cluster0.abcd.mongodb.net" now', 'use "[REDACTED_MONGODB_URI]" now'],
  ])('redacts a connection URI before %s and keeps the JSON valid', (_label, content, expected) => {
    expect(redactJson({ content })).toEqual({ content: expected })
  })

  it.each([
    ['a closing brace', 'cfg={url:postgres://user:pass1@host.example.com}', 'cfg={url:[REDACTED_CONNECTION_URI]}'],
    ['a closing parenthesis', 'connect(postgres://user:pass1@host.example.com)', 'connect([REDACTED_CONNECTION_URI])'],
    ['a comma', 'a=postgres://user:pass1@host.example.com, b=1', 'a=[REDACTED_CONNECTION_URI], b=1'],
  ])('ends a connection URI at %s', (_label, text, expected) => {
    expect(redact(text)).toBe(expected)
  })

  it('leaves the fraction digits of a JSON number alone', () => {
    // Measured: every redacted transcript line that still failed to parse was a
    // float whose fraction digits passed Luhn, redacted to an unquoted marker.
    const scanAll = new DlpScanner({ enabled: true, mode: 'redact', detectors: ['pii'] })
    const body = '{"score":0.4111111111111111,"ratio":[1.5555555555555555,0.3782822463100051]}'
    expect(scanAll.scan(body).filter(f => f.type === 'CREDIT_CARD')).toEqual([])
    expect(scanAll.scan('{"card":"4111 1111 1111 1111"}').some(f => f.type === 'CREDIT_CARD')).toBe(true)
  })

  it.each([
    ['Google API key', 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q', '[REDACTED_GOOGLE_API_KEY]'],
    ['Telegram bot token', '123456789:' + 'AAH1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q', '[REDACTED_TELEGRAM_TOKEN]'],
  ])('finds a %s that ends in a hyphen', (_label, key, marker) => {
    const dashed = key.slice(0, -1) + '-'
    expect(redactJson({ key: dashed })).toEqual({ key: marker })
  })
})
