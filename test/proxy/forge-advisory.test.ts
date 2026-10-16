import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * node-forge <= 1.4.0 has a high-severity advisory (Dependabot alert #57, no
 * patched release as of 2026-10-16): RSA PKCS#1 v1.5 signature VERIFICATION
 * accepts extra nested DigestAlgorithm elements. llm-fw uses forge only to
 * generate and sign (the CA, leaf certificates, the CRL) and to parse PEM, so
 * the vulnerable path is not reached (#254).
 *
 * That was an argument from reading src/. This makes it a property the build
 * enforces: a file that imports node-forge may not call its verification
 * APIs. If one ever must, the advisory becomes reachable and has to be
 * re-assessed before the change lands.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? tsFiles(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

// Signature and chain verification entry points in node-forge.
const VERIFY_APIS = /\.verify\s*\(|verifyCertificateChain|createCaStore|\.verifySubjectKeyIdentifier\s*\(/

describe('node-forge advisory reachability (#254)', () => {
  const forgeFiles = tsFiles(SRC).filter(f => /from ['"]node-forge['"]/.test(fs.readFileSync(f, 'utf8')))

  it('still finds the files that use node-forge (the check is not vacuous)', () => {
    expect(forgeFiles.map(f => path.relative(SRC, f).split(path.sep).join('/')).sort()).toEqual(['cli/start.ts', 'proxy/certs.ts'])
  })

  it('no file that imports node-forge calls a verification API', () => {
    const offenders = forgeFiles.filter(f => VERIFY_APIS.test(fs.readFileSync(f, 'utf8')))
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([])
  })
})
