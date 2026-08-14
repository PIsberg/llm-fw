import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  files?: string[]
}
const OCR_SOURCE = readFileSync(fileURLToPath(new URL('src/detection/ocr.ts', ROOT)), 'utf8')

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
