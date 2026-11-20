import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

// #817: GitHub stopped rendering CHANGELOG.md somewhere between 209 KB (renders)
// and 433 KB (shown as plain source, images included), and nothing noticed until
// #816 moved releases 0.1.0 to 0.8.0 to docs/CHANGELOG-ARCHIVE.md. The 0.9.x
// series alone wrote about 209 KB in three weeks. The ceiling sits below the
// smallest size seen failing, with headroom for one more release.
const CHANGELOG_CEILING_BYTES = 350_000

describe('CHANGELOG.md stays small enough for GitHub to render', () => {
  it(`is under ${CHANGELOG_CEILING_BYTES / 1000} KB`, () => {
    const bytes = fs.statSync('CHANGELOG.md').size
    expect(
      bytes,
      `CHANGELOG.md is ${Math.round(bytes / 1000)} KB; GitHub stops rendering it somewhere above 209 KB and did at 433 KB. ` +
      'Move the oldest minor series to docs/CHANGELOG-ARCHIVE.md (as #816 did), newest first, and keep the link at the top.',
    ).toBeLessThan(CHANGELOG_CEILING_BYTES)
  })

  it('links the archive the oldest releases move to', () => {
    expect(fs.readFileSync('CHANGELOG.md', 'utf8')).toContain('docs/CHANGELOG-ARCHIVE.md')
    expect(fs.existsSync('docs/CHANGELOG-ARCHIVE.md')).toBe(true)
  })
})
