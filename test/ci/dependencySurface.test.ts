import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A default `npm i llm-fw` used to pull ~50 MB and 13 extra packages for OCR,
// a feature that ships off (`nonText.ocr: false`) and is reached through a
// dynamic import. Socket flagged most of that subtree as unmaintained,
// obfuscated or minified, and tesseract.js's postinstall ran a donation script
// on every install.
//
// tesseract.js is now an OPTIONAL PEER dependency. That specific form matters:
// npm installs `optionalDependencies` by default and only skips them on
// failure or with --omit=optional, whereas an optional peer is genuinely not
// installed unless the user asks for it. These tests pin the arrangement,
// because the natural "fix" for a missing module at dev time is to move it
// back into `dependencies` and undo the whole thing.
const ROOT = new URL('../../', import.meta.url)
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', ROOT)), 'utf8')) as {
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  files?: string[]
}
const OCR_SOURCE = readFileSync(fileURLToPath(new URL('src/detection/ocr.ts', ROOT)), 'utf8')
const SECURITY_MD = readFileSync(fileURLToPath(new URL('SECURITY.md', ROOT)), 'utf8')
const NOTICE_MD = readFileSync(fileURLToPath(new URL('NOTICE.md', ROOT)), 'utf8')
const CHART_YAML = readFileSync(fileURLToPath(new URL('deploy/helm/llm-fw/Chart.yaml', ROOT)), 'utf8')

describe('tesseract.js stays off the default install path', () => {
  it('is not a runtime dependency', () => {
    expect(PKG.dependencies ?? {}).not.toHaveProperty('tesseract.js')
  })

  it('is declared as a peer, not an optionalDependency', () => {
    // optionalDependencies would still be installed by default, which is the
    // trap this test exists to catch.
    expect(PKG.peerDependencies ?? {}).toHaveProperty('tesseract.js')
    expect(PKG).not.toHaveProperty('optionalDependencies.tesseract.js')
  })

  it('marks that peer optional so npm does not auto-install it', () => {
    expect(PKG.peerDependenciesMeta?.['tesseract.js']?.optional).toBe(true)
  })

  it('is still a devDependency so the build and tests resolve it', () => {
    expect(PKG.devDependencies ?? {}).toHaveProperty('tesseract.js')
  })
})

describe('the OCR module can survive that absence', () => {
  it('never imports tesseract.js at module scope', () => {
    // A static import would be evaluated when ocr.ts loads, so a missing
    // module would take down the detection pipeline at startup rather than
    // degrading to opaque handling.
    const staticImports = [...OCR_SOURCE.matchAll(/^\s*import\s[^(]*?from\s+['"]([^'"]+)['"]/gm)].map(
      (m) => m[1],
    )

    expect(staticImports).not.toContain('tesseract.js')
  })

  it('reaches it only through a dynamic import', () => {
    expect(OCR_SOURCE).toMatch(/await\s+import\(\s*['"]tesseract\.js['"]\s*\)/)
  })
})

describe('third-party notices ship with the package', () => {
  it('lists NOTICE.md in files, which npm does not include on its own', () => {
    // npm auto-includes README and LICENSE but not NOTICE, so an unlisted
    // NOTICE.md would exist in the repo and be missing from the tarball.
    expect(PKG.files ?? []).toContain('NOTICE.md')
  })
})

describe('SECURITY.md, Chart.yaml and NOTICE.md track the current release and dependency tree', () => {
  it('SECURITY.md lists the current minor line from package.json as supported', () => {
    const [major, minor] = PKG.version.split('.')
    expect(SECURITY_MD).toContain(`| ${major}.${minor}.x   | yes       |`)
  })

  it('Chart.yaml appVersion matches package.json version', () => {
    expect(CHART_YAML).toContain(`appVersion: "${PKG.version}"`)
  })

  it('neither SECURITY.md nor NOTICE.md lists removed node-forge as in the dependency tree', () => {
    expect(SECURITY_MD).not.toMatch(/`node-forge`/)
    expect(NOTICE_MD).not.toMatch(/`node-forge`/)
  })
})

describe('docs/DEPENDENCIES.md accounts for every declared dependency', () => {
  const DEPS_MD = readFileSync(fileURLToPath(new URL('docs/DEPENDENCIES.md', ROOT)), 'utf8')
  const declared = [
    ...Object.keys(PKG.dependencies ?? {}),
    ...Object.keys(PKG.peerDependencies ?? {}),
    ...Object.keys(PKG.devDependencies ?? {}),
  ]

  it.each([...new Set(declared)])('%s has a row', (name) => {
    expect(DEPS_MD).toContain(`| \`${name}\` |`)
  })
})

describe('devDependencies never reach the release', () => {
  it('src/ imports no devDependency except the optional tesseract.js peer', () => {
    // dist/ is compiled from src/, so an import of a dev package from src/
    // would make `npm i llm-fw` fail at runtime with a module-not-found.
    const dev = Object.keys(PKG.devDependencies ?? {}).filter((d) => d !== 'tesseract.js')
    const offenders: string[] = []
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
        if (e.isDirectory()) walk(child)
        else if (e.name.endsWith('.ts')) {
          const text = readFileSync(child, 'utf8')
          for (const d of dev) {
            if (new RegExp(String.raw`(from|import\()\s*['"]${d.replace(/[/.]/g, '\$&')}(/[^'"]*)?['"]`).test(text)) {
              offenders.push(`${fileURLToPath(child)} -> ${d}`)
            }
          }
        }
      }
    }
    walk(new URL('src/', ROOT))
    expect(offenders).toEqual([])
  })

  it('ships only dist, data and NOTICE.md, so no test, script or fixture is packed', () => {
    expect([...(PKG.files ?? [])].sort()).toEqual(['NOTICE.md', 'data', 'dist'])
  })
})

// npmjs.org lists the  field of the published manifest under
// "Dev Dependencies", so Playwright, Vitest and Stryker looked like part of the
// package even though npm never installs them. The release workflow rewrites the
// manifest it publishes; the repository's own package.json keeps the field.
describe('the published manifest carries no dev dependencies', () => {
  const STRIP = fileURLToPath(new URL('scripts/strip-dev-manifest.mjs', ROOT))

  it('removes devDependencies and keeps everything a consumer reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-fw-manifest-'))
    const file = join(dir, 'package.json')
    writeFileSync(file, JSON.stringify(PKG))
    execFileSync(process.execPath, [STRIP, file])
    const out = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(out.devDependencies).toBeUndefined()
    expect(Object.keys(PKG.devDependencies ?? {}).length).toBeGreaterThan(0)
    for (const key of ['name', 'version', 'bin', 'exports', 'files', 'dependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines']) {
      expect(out[key], key).toEqual((PKG as Record<string, unknown>)[key])
    }
  })

  it('runs in the release workflow before npm publish', () => {
    const wf = readFileSync(fileURLToPath(new URL('.github/workflows/release.yml', ROOT)), 'utf8')
    const strip = wf.indexOf('scripts/strip-dev-manifest.mjs')
    expect(strip).toBeGreaterThan(-1)
    expect(strip).toBeLessThan(wf.indexOf('npm publish'))
  })
})
