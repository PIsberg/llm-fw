import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import tls from 'node:tls'
import net from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CertFactory, parseCertificateExtensions, computeSubjectKeyIdentifier } from '../../src/proxy/certs.js'

// OIDs for the identifiers the hardening adds.
const OID_SKI = '2.5.29.14' // subjectKeyIdentifier
const OID_AKI = '2.5.29.35' // authorityKeyIdentifier

describe('CertFactory CA hardening', () => {
  let tempDir: string
  let factory: CertFactory
  let caPem: string
  let leafPem: string
  let caCert: X509Certificate
  let leafCert: X509Certificate

  beforeAll(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-ca-'))
    process.env.LLM_FW_DIR = tempDir
    factory = new CertFactory()
    caPem = factory.generateCA().cert
    leafPem = factory.getHostCert('api.anthropic.com').cert
    caCert = new X509Certificate(caPem)
    leafCert = new X509Certificate(leafPem)
  })

  afterAll(() => {
    delete process.env.LLM_FW_DIR
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('gives the CA a random, positive serial (no longer hardcoded 01)', () => {
    const serial = caCert.serialNumber.toLowerCase()
    expect(serial).not.toBe('01')
    expect(serial).toMatch(/^[0-9a-f]+$/)
    expect(serial.length).toBeGreaterThan(2)
    // High bit cleared → positive INTEGER (first byte 0x00–0x7f).
    expect(parseInt(serial.slice(0, 2), 16)).toBeLessThanOrEqual(0x7f)
  })

  it('two generations of the CA get distinct serials', () => {
    const otherSerial = new X509Certificate(factory.generateCA().cert).serialNumber.toLowerCase()
    expect(otherSerial).not.toBe(caCert.serialNumber.toLowerCase())
  })

  it('the CA carries a subjectKeyIdentifier and the leaf a matching authorityKeyIdentifier', () => {
    const caExts = parseCertificateExtensions(caCert.raw)
    const leafExts = parseCertificateExtensions(leafCert.raw)
    const caSki = caExts.get(OID_SKI)
    const leafAki = leafExts.get(OID_AKI)
    expect(caSki).toBeDefined()
    expect(leafAki).toBeDefined()
    // The AKI keyIdentifier must equal the CA's SKI (key id, method-1 SHA-1 of
    // the SPKI).
    const caKeyId = computeSubjectKeyIdentifier(caCert.publicKey).toString('hex')
    expect(caSki!.toString('hex')).toContain(caKeyId)
    expect(leafAki!.toString('hex')).toContain(caKeyId)
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
