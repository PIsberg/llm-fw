import { describe, it, expect } from 'vitest'
import { DlpScanner } from '../../src/detection/dlp/scanner.js'
import { getParser } from '../../src/detection/parsers.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { maskSecret, locateDlpFindings } from '../../src/proxy/dlpLocation.js'

// #702: a DLP event said what kind of secret it saw and nothing about where,
// so a real leak could not be told from a false positive. The location is
// recorded, the secret never is.

// Assembled, so no file holds a credential-shaped literal.
const SECRET = ['AK', 'IA', 'Q7ZB4N2XKD5M8RT3'].join('')

const scanner = new DlpScanner(DEFAULT_CONFIG.dlp)
const anthropic = getParser('/v1/messages')!
const openai = getParser('/v1/chat/completions')!
const locate = (path: string, body: unknown) => {
  const text = JSON.stringify(body)
  const findings = scanner.scan(text)
  expect(findings.length, 'the test secret must be a DLP finding').toBeGreaterThan(0)
  return locateDlpFindings(getParser(path)!, text, findings)
}

describe('maskSecret', () => {
  it('keeps two characters at each end and the length', () => {
    expect(maskSecret(SECRET)).toBe('AK…T3 (20 chars)')
  })

  it('shows nothing of a secret too short to spare four characters', () => {
    expect(maskSecret('abcdefgh')).toBe('… (8 chars)')
    expect(maskSecret('')).toBe('… (0 chars)')
  })
})

describe('locateDlpFindings', () => {
  it('names a tool result and the tool that returned it', () => {
    const [loc] = locate('/v1/messages', {
      model: 'm', max_tokens: 1,
      messages: [
        { role: 'user', content: 'show me the env' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `AWS_ACCESS_KEY_ID=${SECRET}\n` }] },
      ],
    })
    expect(loc).toEqual({ type: 'AWS_ACCESS_KEY', surface: 'tool_result', toolName: 'Bash', masked: 'AK…T3 (20 chars)' })
  })

  it('names a prompt, a system prompt, and anything else in the request', () => {
    expect(locate('/v1/messages', { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: `key ${SECRET}` }] })[0]!.surface).toBe('prompt')
    expect(locate('/v1/messages', { model: 'm', max_tokens: 1, system: `key ${SECRET}`, messages: [{ role: 'user', content: 'hi' }] })[0]!.surface).toBe('system')
    expect(locate('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], metadata: { k: SECRET } })[0]!.surface).toBe('request')
  })

  it('works for an OpenAI chat tool message', () => {
    const [loc] = locate('/v1/chat/completions', {
      model: 'm',
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":".env"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: `key=${SECRET}` },
      ],
    })
    expect(loc).toMatchObject({ surface: 'tool_result', toolName: 'read_file' })
  })

  it('records one location per finding, at most ten, and never the secret', () => {
    const many = Array.from({ length: 12 }, (_, i) => `k${i}=AKIA${'Q7ZB4N2XKD5M8R'}${String(i).padStart(2, '0')}`).join('\n')
    const locs = locate('/v1/messages', { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: `${many}\n${SECRET}` }] })
    expect(locs).toHaveLength(10)
    expect(JSON.stringify(locs)).not.toContain(SECRET)
    expect(JSON.stringify(locs)).not.toMatch(/AKIA[0-9A-Z]{16}/)
  })

  it('still says something when the body is not the parser\'s JSON', () => {
    const text = `not json ${SECRET}`
    expect(locateDlpFindings(openai, text, scanner.scan(text))[0]).toMatchObject({ surface: 'request' })
    expect(anthropic).toBeTruthy()
  })
})
