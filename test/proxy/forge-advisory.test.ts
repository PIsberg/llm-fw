import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * node-forge <= 1.4.0 carries an unpatched high-severity RSA PKCS#1 v1.5
 * signature verification advisory (Dependabot alert #57, GHSA-86w9-cpqp-85rv)
 * and a dual BSD/GPL-2.0 licence notice. Certificate and CRL generation now
 * runs on node:crypto directly, so node-forge is gone from the dependency
 * tree (#254).
 *
 * These tests pin its removal so neither the package nor an import of it can
 * return silently.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'src')
const TEST = path.join(ROOT, 'test')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? tsFiles(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

describe('node-forge removal (#254)', () => {
  it('is not in dependencies or devDependencies', () => {
    expect(PKG.dependencies ?? {}).not.toHaveProperty('node-forge')
    expect(PKG.devDependencies ?? {}).not.toHaveProperty('node-forge')
    expect(PKG.devDependencies ?? {}).not.toHaveProperty('@types/node-forge')
  })

  it('no file under src/ or test/ imports node-forge', () => {
    const allFiles = [...tsFiles(SRC), ...tsFiles(TEST)]
    const offenders = allFiles.filter(f => /from ['"]node-forge['"]/.test(fs.readFileSync(f, 'utf8')))
    expect(offenders.map(f => path.relative(ROOT, f).split(path.sep).join('/'))).toEqual([])
  })
})
