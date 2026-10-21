import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CertFactory } from '../../src/proxy/certs.js'

const TEST_DIR = join(tmpdir(), 'llm-fw-certs-test-' + process.pid)

describe('CertFactory — key reuse (FIX-2)', () => {
  let factory: CertFactory

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
    process.env.LLM_FW_DIR = TEST_DIR
    factory = new CertFactory()
    factory.generateCA()
  })

  afterAll(() => {
    delete process.env.LLM_FW_DIR
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('warmHostKey() generates a key pair and is idempotent', () => {
    factory.warmHostKey()
    const pair1 = (factory as any).hostKeyPair
    expect(pair1).not.toBeNull()

    factory.warmHostKey() // second call — must not regenerate
    const pair2 = (factory as any).hostKeyPair
    expect(pair2).toBe(pair1) // same object reference
  })

  it('FIX-2: multiple host certs share exactly one private key PEM', () => {
    factory.warmHostKey()

    const hostnames = ['api.anthropic.com', 'generativelanguage.googleapis.com', 'openai.com']
    const keyPems = new Set<string>()
    const cns = new Set<string>()

    for (const hostname of hostnames) {
      const creds = factory.getHostCert(hostname)
      keyPems.add(creds.key)

      const parsed = new X509Certificate(creds.cert)
      const cnMatch = /^CN=(.+)$/m.exec(parsed.subject)
      if (cnMatch?.[1]) cns.add(cnMatch[1])
    }

    // All three certs share exactly ONE private key — no per-hostname RSA generation
    expect(keyPems.size).toBe(1)
    // Each cert has its own distinct CN
    expect(cns.size).toBe(3)
    expect(cns).toContain('api.anthropic.com')
    expect(cns).toContain('generativelanguage.googleapis.com')
  })

  it('FIX-2: getHostCert is fast on subsequent calls (cache hit)', () => {
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) factory.getHostCert('api.anthropic.com')
    const elapsed = performance.now() - t0
    // 100 cache hits should complete in under 50ms (was 100-2000ms per call before fix)
    expect(elapsed).toBeLessThan(50)
  })
})
