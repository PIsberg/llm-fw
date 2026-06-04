import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import tls from 'node:tls'
import net from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import forge from 'node-forge'
import { CertFactory } from '../../src/proxy/certs.js'

// OIDs for the identifiers the hardening adds.
const OID_SKI = '2.5.29.14' // subjectKeyIdentifier
const OID_AKI = '2.5.29.35' // authorityKeyIdentifier

describe('CertFactory CA hardening', () => {
  let tempDir: string
  let factory: CertFactory
  let caPem: string
  let leafPem: string
  let caCert: forge.pki.Certificate
  let leafCert: forge.pki.Certificate

  beforeAll(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-ca-'))
    process.env.LLM_FW_DIR = tempDir
    factory = new CertFactory()
    caPem = factory.generateCA().cert
    leafPem = factory.getHostCert('api.anthropic.com').cert
    caCert = forge.pki.certificateFromPem(caPem)
    leafCert = forge.pki.certificateFromPem(leafPem)
  })

  afterAll(() => {
    delete process.env.LLM_FW_DIR
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('gives the CA a random, positive serial (no longer hardcoded 01)', () => {
    expect(caCert.serialNumber).not.toBe('01')
    expect(caCert.serialNumber).toMatch(/^[0-9a-f]+$/)
    expect(caCert.serialNumber.length).toBeGreaterThan(2)
    // High bit cleared → positive INTEGER (first byte 0x00–0x7f).
    expect(parseInt(caCert.serialNumber.slice(0, 2), 16)).toBeLessThanOrEqual(0x7f)
  })

  it('two generations of the CA get distinct serials', () => {
    const otherSerial = forge.pki.certificateFromPem(factory.generateCA().cert).serialNumber
    expect(otherSerial).not.toBe(caCert.serialNumber)
  })

  it('the CA carries a subjectKeyIdentifier and the leaf a matching authorityKeyIdentifier', () => {
    const caSki = caCert.extensions.find(e => e.id === OID_SKI)
    const leafAki = leafCert.extensions.find(e => e.id === OID_AKI)
    expect(caSki).toBeDefined()
    expect(leafAki).toBeDefined()
    // The AKI keyIdentifier must equal the CA's SKI (key id, method-1 SHA-1 of
    // the SPKI). forge exposes the computed SKI via generateSubjectKeyIdentifier.
    const caKeyId = caCert.generateSubjectKeyIdentifier().toHex()
    expect(forge.util.bytesToHex(leafAki!.value)).toContain(caKeyId)
  })

  it('a strict validator accepts the leaf chained to the CA', async () => {
    const leaf = factory.getHostCert('api.anthropic.com')
    const server = tls.createServer({ key: leaf.key, cert: leaf.cert }, s => s.end('ok'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port

    try {
      const authorized = await new Promise<boolean>((resolve, reject) => {
        const sock = tls.connect(
          { host: '127.0.0.1', port, servername: 'api.anthropic.com', ca: caPem, rejectUnauthorized: true },
          () => { const ok = sock.authorized; sock.end(); resolve(ok) },
        )
        sock.on('error', reject)
      })
      expect(authorized).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
