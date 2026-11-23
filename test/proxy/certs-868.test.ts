import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CertFactory } from '../../src/proxy/certs.js'

// #868: leaf certificates issued for intercepted hosts.
const TEST_DIR = join(tmpdir(), 'llm-fw-certs-868-' + process.pid)

describe('CertFactory leaf certificates (#868)', () => {
  let factory: CertFactory
  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
    process.env.LLM_FW_DIR = TEST_DIR
    factory = new CertFactory()
    factory.generateCA()
  })
  afterAll(() => {
    vi.useRealTimers()
    delete process.env.LLM_FW_DIR
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  })
  const leaf = (host: string) => new X509Certificate(factory.getHostCert(host).cert)

  it('is valid from a day back, so a client whose clock is behind accepts it', () => {
    const from = new Date(leaf('skew.example.com').validFrom).getTime()
    expect(Date.now() - from).toBeGreaterThanOrEqual(23 * 3600_000)
  })

  it.each(['10.20.30.40', '::1', '2001:db8::7'])('names an IP address host %s as an IP SAN, which TLS verification checks', (ip) => {
    const cert = leaf(ip)
    expect(cert.checkIP(ip)).toBe(ip)
    expect(cert.subjectAltName).toMatch(/IP Address:/)
  })

  it('still names a DNS host as a DNS SAN', () => {
    expect(leaf('dns.example.com').checkHost('dns.example.com')).toBe('dns.example.com')
  })

  it('keeps at most 256 certificates, evicting the least recently used', () => {
    const kept = factory.getHostCert('kept.example.com').cert
    const evicted = factory.getHostCert('evicted.example.com').cert
    for (let i = 0; i < 300; i++) {
      factory.getHostCert(`h${i}.example.com`)
      factory.getHostSecureContext(`h${i}.example.com`)
      if (i % 50 === 0) factory.getHostCert('kept.example.com')
    }
    expect(factory.getHostCert('kept.example.com').cert).toBe(kept)
    expect(factory.getHostCert('evicted.example.com').cert).not.toBe(evicted)
  })

  it('issues a new certificate once the cached one is a day from expiring', () => {
    const first = factory.getHostCert('expiring.example.com').cert
    const context = factory.getHostSecureContext('expiring.example.com')
    vi.useFakeTimers({ now: Date.now() + 365 * 24 * 3600_000 })
    const again = factory.getHostCert('expiring.example.com').cert
    expect(again).not.toBe(first)
    expect(new Date(new X509Certificate(again).validTo).getTime()).toBeGreaterThan(Date.now())
    expect(factory.getHostSecureContext('expiring.example.com')).not.toBe(context)
    vi.useRealTimers()
  })
})
