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
  it('generates a CA when none exists', () => {
    expect(new CertFactory().ensureCA()).toBe('generated')
    expect(read('ca.crt')).toContain('BEGIN CERTIFICATE')
  })

  it('keeps an existing, valid CA byte for byte', () => {
    new CertFactory().ensureCA()
    const cert = read('ca.crt')
    const key = read('ca.key')
    expect(new CertFactory().ensureCA()).toBe('reused')
    expect(read('ca.crt')).toBe(cert)
    expect(read('ca.key')).toBe(key)
  })

  it('replaces a CA whose key is missing', () => {
    new CertFactory().ensureCA()
    const cert = read('ca.crt')
    fs.rmSync(join(dir, 'ca.key'))
    expect(new CertFactory().ensureCA()).toBe('generated')
    expect(read('ca.crt')).not.toBe(cert)
  })

  it('replaces a CA whose key does not belong to the certificate', () => {
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
    expect(new CertFactory().ensureCA()).toBe('generated')
    expect(read('ca.crt')).not.toBe(cert)
  })

  it('replaces a CA whose CRL distribution point is not the one this install serves', () => {
    // The CRL URL is baked into the CA; Windows Schannel rejects a leaf whose
    // revocation status it cannot fetch, so a moved dashboard needs a new CA.
    new CertFactory('http://127.0.0.1:7731/crl').ensureCA()
    const cert = read('ca.crt')
    expect(new CertFactory('http://127.0.0.1:9731/crl').ensureCA()).toBe('generated')
    expect(read('ca.crt')).not.toBe(cert)
  })
})
