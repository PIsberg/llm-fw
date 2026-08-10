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
  CONTACT_EMAIL,
  UNLICENSED_NOTICE,
  statusLine,
  unlicensedBanner,
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
  it('prints the full notice to stdout', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run()
    expect(log).toHaveBeenCalledWith(NOTICE)
  })

  it("follows the notice with this machine's licence state", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run()
    // A notice that never says whether THIS machine is licensed leaves the
    // reader to guess, which is the state the whole feature exists to end.
    expect(log.mock.calls.flat().join('\n')).toMatch(/Licence:/)
  })
})

// The buy-a-licence prompt is the only thing an unlicensed user is given to act
// on, so both channels have to survive any future edit of the wording.
describe('unlicensed notice', () => {
  it('names both the email and the URL', () => {
    expect(UNLICENSED_NOTICE).toContain(CONTACT_EMAIL)
    expect(UNLICENSED_NOTICE).toContain(COMMERCIAL_URL)
  })

  it('is repeated in the full notice, so `llm-fw license` is a complete answer', () => {
    expect(NOTICE).toContain(CONTACT_EMAIL)
    expect(NOTICE).toContain(COMMERCIAL_URL)
    expect(NOTICE).toContain('llm-fw license --activate')
  })
})

describe('unlicensedBanner', () => {
  it('prints nothing when the machine is licensed', () => {
    expect(unlicensedBanner({ state: 'licensed' })).toEqual([])
  })

  it.each(['unlicensed', 'expired', 'invalid', 'unverified'] as const)(
    'prints a buyable banner when the state is %s',
    state => {
      const banner = unlicensedBanner({ state }).join('\n')
      expect(banner).toContain(COMMERCIAL_URL)
      expect(banner).toContain(CONTACT_EMAIL)
    },
  )
})

describe('statusLine', () => {
  it('names the holder, plan and expiry of a live licence', () => {
    const line = statusLine({
      state: 'licensed',
      holder: 'Acme AB',
      plan: 'team',
      expiry: '2027-03-01T00:00:00.000Z',
    })
    expect(line).toContain('Acme AB')
    expect(line).toContain('team')
    expect(line).toContain('2027-03-01')
  })

  it.each(['unlicensed', 'expired', 'invalid'] as const)('points %s at a way to pay', state => {
    expect(statusLine({ state })).toMatch(
      new RegExp(`${COMMERCIAL_URL}|${CONTACT_EMAIL.replace(/\./g, '\\.')}`),
    )
  })
})
