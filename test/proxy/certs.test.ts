import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import forge from 'node-forge'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CertFactory } from '../../src/proxy/certs.js'

const TEST_DIR = join(tmpdir(), 'llm-fw-certs-test-' + process.pid)

function makeTestCA() {
  const caKeys = forge.pki.rsa.generateKeyPair(2048)
  const caCert = forge.pki.createCertificate()
  caCert.publicKey = caKeys.publicKey
  caCert.serialNumber = '01'
  const now = new Date()
  const later = new Date(); later.setFullYear(later.getFullYear() + 1)
  caCert.validity.notBefore = now
  caCert.validity.notAfter = later
  const attrs = [{ name: 'commonName', value: 'test CA' }]
  caCert.setSubject(attrs); caCert.setIssuer(attrs)
  caCert.setExtensions([{ name: 'basicConstraints', cA: true }])
  caCert.sign(caKeys.privateKey, forge.md.sha256.create())
  return { cert: caCert, key: caKeys.privateKey }
}

describe('CertFactory — key reuse (FIX-2)', () => {
  let factory: CertFactory

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
    factory = new CertFactory()
    // Inject a fake CA so tests don't touch disk
    ;(factory as any).caForge = makeTestCA()
  })

  afterAll(() => {
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

      const parsed = forge.pki.certificateFromPem(creds.cert)
      cns.add(parsed.subject.getField('CN')?.value)
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
