import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The directory in force when certs.ts is first imported. A factory used to
// capture it at module load, so every test file that set LLM_FW_DIR in a
// hook (after the import) wrote its CA into the developer's real ~/.llm-fw.
const loadDir = vi.hoisted(() => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'llm-fw-ca-load-'))
  process.env.LLM_FW_DIR = dir
  return dir as string
})

import { CertFactory } from '../../src/proxy/certs.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-ca-ensure-'))
  process.env.LLM_FW_DIR = dir
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  delete process.env.LLM_FW_DIR
  fs.rmSync(loadDir, { recursive: true, force: true })
})

const read = (name: string) => fs.readFileSync(join(dir, name), 'utf8')
/** Files a replacement kept, certificate first. */
const replaced = () => fs.readdirSync(dir).filter(f => f.includes('.replaced-')).sort()

// Each case makes two or three 2048-bit RSA keys in pure JS, which took over 5 s
// apiece under the parallel full suite.
const SLOW = { timeout: 60_000 }

describe('CertFactory CA location', SLOW, () => {
  it('writes the CA under LLM_FW_DIR as set when the CA is made, not when the module loaded', () => {
    new CertFactory().generateCA()
    expect(fs.existsSync(join(dir, 'ca.crt'))).toBe(true)
    expect(fs.existsSync(join(dir, 'ca.key'))).toBe(true)
    expect(fs.existsSync(join(loadDir, 'ca.crt'))).toBe(false)
  })
})

describe('CertFactory.ensureCA', SLOW, () => {
  // Re-running `llm-fw setup` (which its own output asks a non-admin user to
  // do, elevated, to enable the sinkhole) used to mint a new CA every time,
  // silently untrusting every client and container that trusted the old one.
  it('generates a CA when none exists, and has nothing to keep', () => {
    expect(new CertFactory().ensureCA()).toEqual({ outcome: 'generated', reason: 'missing' })
    expect(read('ca.crt')).toContain('BEGIN CERTIFICATE')
    expect(replaced()).toEqual([])
  })

  it('keeps an existing, valid CA byte for byte', () => {
    new CertFactory().ensureCA()
    const cert = read('ca.crt')
    const key = read('ca.key')
    expect(new CertFactory().ensureCA()).toEqual({ outcome: 'reused' })
    expect(read('ca.crt')).toBe(cert)
    expect(read('ca.key')).toBe(key)
    expect(replaced()).toEqual([])
  })

  // #692: setup replaced a live CA and could not say why, and the overwritten
  // pair took the evidence with it. Each check now names itself, and the old
  // files are kept beside the new ones.
  it('replaces a CA whose key is missing, says so, and keeps the certificate', () => {
    new CertFactory().ensureCA()
    const cert = read('ca.crt')
    fs.rmSync(join(dir, 'ca.key'))
    const result = new CertFactory().ensureCA()
    expect(result).toMatchObject({ outcome: 'generated', reason: 'missing' })
    expect(read('ca.crt')).not.toBe(cert)
    expect(replaced()).toEqual([expect.stringMatching(/^ca\.crt\.replaced-\d{8}T\d{6}Z$/)])
    expect(read(replaced()[0]!)).toBe(cert)
  })

  it('replaces a CA that cannot be read', () => {
    new CertFactory().ensureCA()
    fs.writeFileSync(join(dir, 'ca.crt'), 'not a certificate')
    expect(new CertFactory().ensureCA()).toMatchObject({ outcome: 'generated', reason: 'unreadable' })
    expect(replaced()).toHaveLength(2)
  })

  it('replaces a CA whose key does not belong to the certificate, and keeps both old files', () => {
    new CertFactory().ensureCA()
    const cert = read('ca.crt')
    // Another generation's key next to this certificate.
    const other = fs.mkdtempSync(join(tmpdir(), 'llm-fw-ca-other-'))
    process.env.LLM_FW_DIR = other
    new CertFactory().generateCA()
    const otherKey = fs.readFileSync(join(other, 'ca.key'), 'utf8')
    process.env.LLM_FW_DIR = dir
    fs.writeFileSync(join(dir, 'ca.key'), otherKey)
    fs.rmSync(other, { recursive: true, force: true })
    const result = new CertFactory().ensureCA()
    expect(result).toEqual({
      outcome: 'generated', reason: 'key-mismatch',
      keptAs: [expect.stringMatching(/ca\.crt\.replaced-/), expect.stringMatching(/ca\.key\.replaced-/)],
    })
    expect(read('ca.crt')).not.toBe(cert)
    const [oldCert, oldKey] = replaced()
    expect(read(oldCert!)).toBe(cert)
    expect(read(oldKey!)).toBe(otherKey)
  })

  it('replaces a CA that has expired', () => {
    new CertFactory().ensureCA()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2200-01-01T00:00:00Z'))
      expect(new CertFactory().ensureCA()).toMatchObject({ outcome: 'generated', reason: 'expired' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('replaces a CA whose CRL distribution point is not the one this install serves', () => {
    // The CRL URL is baked into the CA; Windows Schannel rejects a leaf whose
    // revocation status it cannot fetch, so a moved dashboard needs a new CA.
    new CertFactory('http://127.0.0.1:7731/crl').ensureCA()
    const cert = read('ca.crt')
    expect(new CertFactory('http://127.0.0.1:9731/crl').ensureCA()).toMatchObject({ outcome: 'generated', reason: 'crl-url' })
    expect(read('ca.crt')).not.toBe(cert)
  })

  it('never overwrites an earlier kept pair when a second replacement lands in the same second', () => {
    new CertFactory().ensureCA()
    fs.rmSync(join(dir, 'ca.key'))
    new CertFactory().ensureCA()
    fs.rmSync(join(dir, 'ca.key'))
    new CertFactory().ensureCA()
    expect(replaced()).toHaveLength(2)
  })
})
