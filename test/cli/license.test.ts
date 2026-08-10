import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  NOTICE,
  SHORT_NOTICE,
  LICENSE_NAME,
  LICENSE_URL,
  COMMERCIAL_URL,
  run,
} from '../../src/cli/license.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const licenseFile = readFileSync(join(repoRoot, 'LICENSE.md'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

afterEach(() => {
  vi.restoreAllMocks()
})

// LICENSE.md is the authority; src/cli/license.ts is a copy of it phrased for a
// terminal. These tests are what stop the copy from drifting — relicense the
// project and the CLI's claims about the licence go red instead of quietly
// telling users the wrong thing.
describe('licence notice agrees with LICENSE.md', () => {
  it('names the licence LICENSE.md actually grants', () => {
    expect(licenseFile).toContain(LICENSE_NAME)
  })

  it('links the canonical licence URL that LICENSE.md cites', () => {
    expect(licenseFile).toContain(LICENSE_URL)
  })

  it('repeats the Required Notice copyright line verbatim', () => {
    const required = licenseFile.match(/^Required Notice: (.+)$/m)
    expect(required, 'LICENSE.md must carry a Required Notice line').not.toBeNull()
    // PolyForm's Notices clause obliges downstream recipients to pass this on,
    // so the string the CLI prints has to be the string the licence names.
    expect(NOTICE).toContain(required![1].trim())
  })

  it('does not claim a licence package.json contradicts', () => {
    expect(packageJson.license).toBe('SEE LICENSE IN LICENSE.md')
  })
})

describe('licence notice states the commercial boundary', () => {
  it('says noncommercial use is free', () => {
    expect(NOTICE).toMatch(/noncommercial/i)
    expect(SHORT_NOTICE).toMatch(/free for noncommercial use/i)
  })

  it('says commercial use is not granted, and where to buy it', () => {
    expect(NOTICE).toMatch(/NOT GRANTED BY THIS LICENCE/)
    expect(NOTICE).toContain(COMMERCIAL_URL)
    expect(SHORT_NOTICE).toContain(COMMERCIAL_URL)
  })

  it('keeps the short notice to one line, since start.ts prints it inline', () => {
    expect(SHORT_NOTICE).not.toContain('\n')
  })
})

describe('llm-fw license', () => {
  it('prints the full notice to stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    run()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(NOTICE)
  })
})
