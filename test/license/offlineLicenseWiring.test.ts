import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { isOfflineLicenseConfigured, offlineLicenseVerifyKey } from '../../src/license/account.js'
import { licenseStatus, licenseFilePath } from '../../src/license/status.js'
import { run } from '../../src/cli/license.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const issuer = join(repoRoot, 'scripts', 'issue-offline-license.ts')

// The offline-licence path has no server behind it, so nothing outside this
// file notices when its two halves stop agreeing. `scripts/issue-offline-license.ts`
// and `src/license/offlineLicense.ts` each hard-code the format prefix (LFW1)
// and the product name, and the verify key is a constant an operator pastes in
// by hand. test/license/offlineLicense.test.ts covers the signature maths with
// keys it generates itself, which is exactly why it stayed green while 0.4.0
// shipped with the key left empty. These tests run the real issuing script
// through the real CLI and assert on what a customer's machine would report.

const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['LLM_FW_DIR', 'LLM_FW_OFFLINE_LICENSE_KEY', 'LLM_FW_LICENSE_FILE', 'LLM_FW_LICENSE_KEY']
let tempDir: string

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  tempDir = mkdtempSync(join(tmpdir(), 'llm-fw-offline-'))
  process.env.LLM_FW_DIR = tempDir
  delete process.env.LLM_FW_LICENSE_FILE
  delete process.env.LLM_FW_LICENSE_KEY
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]!
  }
  rmSync(tempDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/**
 * Every test that calls issuerRun spawns a fresh Node with the tsx ESM loader
 * to run the real issuing script. That bootstrap alone costs seconds, and under
 * the full suite's contention it ran past vitest's 5 s default and failed two
 * tests that pass in isolation. A flaky gate is worse than a slow one: it
 * teaches everyone to re-run rather than read the failure.
 */
const SPAWN_TIMEOUT_MS = 60_000

/** Run the real issuing script, the way an operator does. */
function issuerRun(args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx/esm', issuer, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** keygen into a temp dir; returns the 64-char hex the operator would paste. */
function throwawayKeypair(sub = 'signing'): { dir: string; hex: string } {
  const dir = join(tempDir, sub)
  const out = issuerRun(['keygen', dir])
  const hex = out.trim().split(/\r?\n/).pop()!.trim()
  expect(hex, `keygen should print a 64-char hex key, printed: ${out}`).toMatch(/^[0-9a-f]{64}$/)
  return { dir, hex }
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

describe('the released build can actually verify an offline licence file', { timeout: SPAWN_TIMEOUT_MS }, () => {
  // The regression that matters most: 0.4.0 shipped OFFLINE_LICENSE_VERIFY_KEY
  // empty, so every offline file a customer activated reported `unverified`.
  // Nothing was red, because no test asserted on the shipped constant.
  it('has a verify key compiled in, not just available via the env override', () => {
    delete process.env.LLM_FW_OFFLINE_LICENSE_KEY
    expect(
      offlineLicenseVerifyKey(),
      'OFFLINE_LICENSE_VERIFY_KEY in src/license/account.ts is empty — a release built ' +
        'from this tree reports every offline licence file as unverified',
    ).toMatch(/^[0-9a-f]{64}$/)
    expect(isOfflineLicenseConfigured()).toBe(true)
  })
})

describe('offline licence, end to end: issuing script -> CLI -> status', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('activates a freshly issued file and reports it licensed, with the issued identity', async () => {
    const { dir, hex } = throwawayKeypair()
    process.env.LLM_FW_OFFLINE_LICENSE_KEY = hex

    const expires = isoDaysFromNow(90)
    const filePath = join(tempDir, 'acme.lfw-license')
    issuerRun([
      'issue',
      '--key', join(dir, 'private.pem'),
      '--licensee', 'Acme Corp AB',
      '--expires', expires,
      '--out', filePath,
      '--plan', 'team',
    ])

    await run(['--activate-file', filePath])

    // The CLI stores it where status looks for it, without the caller passing a path.
    expect(existsSync(licenseFilePath())).toBe(true)

    const status = licenseStatus()
    expect(status.state).toBe('licensed')
    expect(status.holder).toBe('Acme Corp AB')
    expect(status.plan).toBe('team')
    expect(status.expiry).toBe(expires)
  })

  it('agrees with the issuing script on the file format', async () => {
    // Both sides hard-code 'LFW1' and 'llm-fw' independently. If either moves,
    // files issued by the shipped script stop verifying in the shipped library.
    const { dir, hex } = throwawayKeypair()
    process.env.LLM_FW_OFFLINE_LICENSE_KEY = hex
    const filePath = join(tempDir, 'fmt.lfw-license')
    issuerRun([
      'issue',
      '--key', join(dir, 'private.pem'),
      '--licensee', 'Format Check',
      '--expires', isoDaysFromNow(30),
      '--out', filePath,
    ])

    expect(readFileSync(filePath, 'utf8')).toMatch(/^LFW1\./)

    await run(['--activate-file', filePath])
    expect(licenseStatus().state).toBe('licensed')
  })

  it('reports a file signed by anyone else as invalid, not licensed', async () => {
    const { dir } = throwawayKeypair()
    // Build trusts a different key than the one that signed the file.
    const other = throwawayKeypair('other')
    process.env.LLM_FW_OFFLINE_LICENSE_KEY = other.hex

    const filePath = join(tempDir, 'forged.lfw-license')
    issuerRun([
      'issue',
      '--key', join(dir, 'private.pem'),
      '--licensee', 'Not Acme',
      '--expires', isoDaysFromNow(30),
      '--out', filePath,
    ])

    await run(['--activate-file', filePath])
    expect(licenseStatus().state).toBe('invalid')
  })

  it('reports an out-of-date file as expired rather than licensed', async () => {
    const { dir, hex } = throwawayKeypair()
    process.env.LLM_FW_OFFLINE_LICENSE_KEY = hex
    const filePath = join(tempDir, 'old.lfw-license')
    // The issuer refuses to backdate, so issue a short licence and read the
    // clock forward — the same thing that happens to a customer in 8 days.
    const expires = isoDaysFromNow(7)
    issuerRun([
      'issue',
      '--key', join(dir, 'private.pem'),
      '--licensee', 'Lapsed Ltd',
      '--expires', expires,
      '--out', filePath,
    ])

    await run(['--activate-file', filePath])
    expect(licenseStatus().state).toBe('licensed')
    expect(licenseStatus(new Date(Date.now() + 8 * 86_400_000)).state).toBe('expired')
  })

  it('does not report a tampered payload as licensed', async () => {
    const { dir, hex } = throwawayKeypair()
    process.env.LLM_FW_OFFLINE_LICENSE_KEY = hex
    const filePath = join(tempDir, 'tampered.lfw-license')
    issuerRun([
      'issue',
      '--key', join(dir, 'private.pem'),
      '--licensee', 'Small Co',
      '--expires', isoDaysFromNow(30),
      '--out', filePath,
    ])

    // Re-sign nothing, just rewrite the claim: swap the payload for one naming
    // a different licensee, keeping the original signature.
    const [prefix, , sig] = readFileSync(filePath, 'utf8').trim().split('.')
    const forgedPayload = Buffer.from(
      `product=llm-fw\nlicensee=Enterprise Co\nissued=${isoDaysFromNow(0)}\nexpires=${isoDaysFromNow(3650)}`,
      'utf8',
    ).toString('base64url')
    writeFileSync(filePath, `${prefix}.${forgedPayload}.${sig}\n`, 'utf8')

    await run(['--activate-file', filePath])
    expect(licenseStatus().state).toBe('invalid')
  })
})

describe('verification cannot be turned off from the environment', { timeout: SPAWN_TIMEOUT_MS }, () => {
  // offlineLicenseVerifyKey() is `env || COMPILED_IN`, so a blank env var falls
  // through to the shipped key rather than disabling the check. Worth pinning:
  // the obvious way to try to neuter licensing from outside does not work, and
  // an empty LLM_FW_OFFLINE_LICENSE_KEY must never be read as "trust anything".
  it('falls back to the compiled-in key when the override is blank', async () => {
    const { dir } = throwawayKeypair()
    process.env.LLM_FW_OFFLINE_LICENSE_KEY = ''
    const filePath = join(tempDir, 'blank-override.lfw-license')
    issuerRun([
      'issue',
      '--key', join(dir, 'private.pem'),
      '--licensee', 'Acme Corp AB',
      '--expires', isoDaysFromNow(30),
      '--out', filePath,
    ])

    await run(['--activate-file', filePath])
    // Signed by a throwaway key the shipped build does not trust.
    expect(licenseStatus().state).toBe('invalid')
    expect(offlineLicenseVerifyKey()).toMatch(/^[0-9a-f]{64}$/)
  })

  // The unconfigured-build path (empty verify key) is covered directly in
  // offlineLicense.test.ts, which passes the key in as an argument. It cannot be
  // reproduced through the env here, which is the point of the test above.
})

describe('an offline file takes precedence over a Keygen key', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('reports the offline licence as the source when both are present', async () => {
    // licenseStatus returns on the offline file before it reads the Keygen key.
    // Documented in docs/LICENSING.md as "the offline file wins"; pinned here so
    // a change to that precedence has to be a deliberate, noted one.
    const { dir, hex } = throwawayKeypair()
    process.env.LLM_FW_OFFLINE_LICENSE_KEY = hex
    process.env.LLM_FW_LICENSE_KEY = 'a-keygen-key-that-would-otherwise-be-read'
    const filePath = join(tempDir, 'precedence.lfw-license')
    issuerRun([
      'issue',
      '--key', join(dir, 'private.pem'),
      '--licensee', 'Acme Corp AB',
      '--expires', isoDaysFromNow(30),
      '--out', filePath,
    ])

    await run(['--activate-file', filePath])
    const status = licenseStatus()
    expect(status.source).toMatch(/^offline/)
    expect(status.state).toBe('licensed')
    expect(status.holder).toBe('Acme Corp AB')
  })
})

describe('the operator signing key matches what the build trusts', { timeout: SPAWN_TIMEOUT_MS }, () => {
  // Only meaningful on the machine holding private.pem. CI has no private key,
  // so this skips there — a skip, not a pass.
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const operatorKey = join(home, '.config', 'deversity', 'llmfw-offline-license-signing', 'private.pem')
  const haveKey = home !== '' && existsSync(operatorKey)

  it.skipIf(!haveKey)('issues a file with the real private key that the shipped build accepts', async () => {
    delete process.env.LLM_FW_OFFLINE_LICENSE_KEY
    const filePath = join(tempDir, 'real.lfw-license')
    issuerRun([
      'issue',
      '--key', operatorKey,
      '--licensee', 'Signing Key Check',
      '--expires', isoDaysFromNow(30),
      '--out', filePath,
    ])

    await run(['--activate-file', filePath])
    const status = licenseStatus()
    expect(
      status.state,
      'the private key in ~/.config/deversity does not match OFFLINE_LICENSE_VERIFY_KEY — ' +
        'files issued for customers would not verify on the released build',
    ).toBe('licensed')
    expect(status.holder).toBe('Signing Key Check')
  })
})
