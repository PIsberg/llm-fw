import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import forge from 'node-forge'

const OID_CDP = '2.5.29.31' // cRLDistributionPoints

/**
 * The CRL distribution point is not decoration: docs/ARCHITECTURE.md records
 * that Windows Schannel rejects a leaf whose revocation status it cannot
 * determine, which is why every issued certificate carries one.
 *
 * It used to be hardcoded to `http://127.0.0.1:7731/crl`, ignoring
 * `dashboard.port`. Two consequences, both silent: an operator who moved the
 * dashboard broke revocation checking for every certificate the firewall
 * issues, and a remote client was pointed at port 7731 on *its own* machine.
 */
describe('CRL distribution point follows the dashboard address', () => {
  let tempDir: string
  let certs: typeof import('../../src/proxy/certs.js')

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-crl-'))
    // certs.ts resolves the llm-fw dir at module load, so the env var has to be
    // set before the import — otherwise this test would write a CA over the
    // developer's real one.
    process.env.LLM_FW_DIR = tempDir
    certs = await import('../../src/proxy/certs.js')
  })

  afterAll(() => {
    delete process.env.LLM_FW_DIR
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const cdpOf = (pem: string): string => {
    const cert = forge.pki.certificateFromPem(pem)
    const ext = (cert.extensions as { id?: string; value?: string }[]).find(e => e.id === OID_CDP)
    expect(ext, 'certificate carries no cRLDistributionPoints extension').toBeDefined()
    return Buffer.from(ext?.value ?? '', 'binary').toString('latin1')
  }

  it('derives the URL from the configured dashboard port', () => {
    expect(certs.crlUrlFor('127.0.0.1', 9000)).toBe('http://127.0.0.1:9000/crl')
  })

  it('keeps the historical default when nothing is configured', () => {
    expect(certs.crlUrlFor(undefined, 7731)).toBe('http://127.0.0.1:7731/crl')
  })

  it('never emits a wildcard bind as a reachable address', () => {
    // 0.0.0.0 is not routable. A client handed it cannot fetch the CRL, so the
    // wildcard resolves to whatever address this host is actually reachable on.
    for (const wildcard of ['0.0.0.0', '::']) {
      const url = certs.crlUrlFor(wildcard, 7731)
      expect(url).not.toContain(wildcard)
      expect(url).toMatch(/^http:\/\/.+:7731\/crl$/)
    }
  })

  it('embeds the configured URL in the CA and in every leaf', () => {
    const factory = new certs.CertFactory('http://fw.example.com:9000/crl')
    const caPem = factory.generateCA().cert
    const leafPem = factory.getHostCert('api.anthropic.com').cert

    expect(cdpOf(caPem)).toContain('http://fw.example.com:9000/crl')
    // The leaf is the one a validator checks, so it matters most.
    expect(cdpOf(leafPem)).toContain('http://fw.example.com:9000/crl')
    expect(cdpOf(leafPem)).not.toContain('127.0.0.1:7731')
  })

  it('still defaults to loopback:7731 for callers that pass nothing', () => {
    const leafPem = new certs.CertFactory().getHostCert('api.openai.com').cert
    expect(cdpOf(leafPem)).toContain('http://127.0.0.1:7731/crl')
  })
})
