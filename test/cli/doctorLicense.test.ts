import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { licenseCheck, summarize } from '../../src/cli/doctor.js'
import { COMMERCIAL_URL, CONTACT_EMAIL } from '../../src/cli/license.js'
import type { LicenseStatus } from '../../src/license/status.js'

const savedEnv = { ...process.env }
// 64 hex chars — enough for isKeygenConfigured(); the signature maths is
// exercised in test/license/keygenKey.test.ts, not here.
const CONFIGURED_KEY = 'a'.repeat(64)

beforeEach(() => {
  process.env['LLM_FW_KEYGEN_PUBLIC_KEY'] = CONFIGURED_KEY
})

afterEach(() => {
  process.env = { ...savedEnv }
})

const states: LicenseStatus['state'][] = ['licensed', 'unlicensed', 'expired', 'invalid', 'unverified']

describe('licenseCheck', () => {
  // The load-bearing one. `doctor` exits non-zero when any check is `fail`, and
  // CI pipelines gate on that. Licensing must never be able to flip that bit:
  // a machine that intercepts correctly is healthy whether or not it has paid.
  it.each(states)('never returns a fail-level check for state %s', state => {
    const check = licenseCheck({ state })
    expect(check.level).not.toBe('fail')
    expect(summarize([check]).healthy).toBe(true)
  })

  it('reports a licensed machine as ok', () => {
    expect(licenseCheck({ state: 'licensed', holder: 'Acme AB' })).toMatchObject({ level: 'ok' })
  })

  it.each(['unlicensed', 'expired', 'invalid'] as const)('warns and offers a way to pay for %s', state => {
    const check = licenseCheck({ state })
    expect(check.level).toBe('warn')
    const text = [check.title, check.detail, ...(check.fix ?? [])].join('\n')
    expect(text).toContain(COMMERCIAL_URL)
    expect(text).toContain(CONTACT_EMAIL)
  })

  it('blames the key when the build can verify but the key is not signed', () => {
    const check = licenseCheck({ state: 'unverified' })
    expect(check.title).toMatch(/not a cryptographic key/)
    expect(check.fix).toContain('llm-fw license --verify')
  })

  it('blames the build when no account public key was compiled in', () => {
    process.env['LLM_FW_KEYGEN_PUBLIC_KEY'] = ''
    const check = licenseCheck({ state: 'unverified' })
    // Telling a customer to re-check their key is useless when the binary is the
    // thing that cannot check anything.
    expect(check.title).toMatch(/build cannot verify/)
    expect(check.fix?.join(' ')).toContain(CONTACT_EMAIL)
  })
})
