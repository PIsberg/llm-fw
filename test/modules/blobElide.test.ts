import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { BlobElideModule, elideBlobs } from '../../src/modules/builtin/blobElide.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const b64 = (chars: number, seed = 1) => crypto.createHash('sha512').update(String(seed)).digest().toString('base64').replace(/=/g, '').repeat(Math.ceil(chars / 86)).slice(0, chars)
const hex = (chars: number) => crypto.createHash('sha256').update('h').digest('hex').repeat(Math.ceil(chars / 64)).slice(0, chars)

describe('elideBlobs', () => {
  it('replaces a long base64 run with its length and a short hash', () => {
    const blob = b64(3000)
    const out = elideBlobs(`before ${blob} after`, 2048)
    expect(out).toMatch(/^before \[llm-fw: 3000-character base64 blob elided, sha256 [0-9a-f]{8}\] after$/)
  })

  it('keeps the data URI prefix and the JSON around a blob valid', () => {
    const json = JSON.stringify({ file: 'logo.png', data: `data:image/png;base64,${b64(4000)}` })
    const out = elideBlobs(json, 2048)
    const parsed = JSON.parse(out)
    expect(parsed.file).toBe('logo.png')
    expect(parsed.data).toMatch(/^data:image\/png;base64,\[llm-fw: \d+-character base64 blob elided/)
  })

  it('elides hex the same way', () => {
    expect(elideBlobs(hex(2500), 2048)).toMatch(/^\[llm-fw: 2500-character base64 blob elided/)
  })

  it('gives the same blob the same marker and different blobs different ones', () => {
    const a = b64(3000, 1)
    const b = b64(3000, 2)
    expect(elideBlobs(a, 2048)).toBe(elideBlobs(a, 2048))
    expect(elideBlobs(a, 2048)).not.toBe(elideBlobs(b, 2048))
  })

  it('leaves short runs and runs without digits alone', () => {
    const short = b64(2000)
    expect(elideBlobs(short, 2048)).toBe(short)
    const word = 'a'.repeat(5000)
    expect(elideBlobs(word, 2048)).toBe(word)
  })

  it('stays linear on runs just shorter than the minimum', () => {
    // With the length inside the pattern, a 2,047-character run was rescanned
    // from every start position: quadratic per run.
    const text = (b64(2047) + ' ').repeat(250)
    const t0 = performance.now()
    expect(elideBlobs(text, 2048)).toBe(text)
    expect(performance.now() - t0).toBeLessThan(100)
  })
})

describe('BlobElideModule', () => {
  it('elides in tool output only, with the live minimum length', () => {
    const cfg = { enabled: true, minLength: 2048 }
    const mod = new BlobElideModule(cfg)
    const blob = b64(3000)
    const body = JSON.stringify({ messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't', content: blob },
      { type: 'text', text: `decode this: ${blob}` },
    ] }] })
    const parsed = JSON.parse(mod.transformRequest(body, ctx).body)
    expect(parsed.messages[0].content[0].content).toMatch(/^\[llm-fw: 3000-character/)
    expect(parsed.messages[0].content[1].text).toBe(`decode this: ${blob}`)
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)

    cfg.minLength = 4000
    expect(mod.transformRequest(body, ctx).modified).toBe(false)
  })
})
