// The licence terms in one place the CLI can print, plus the licence-key
// commands. `llm-fw license` exists so that "what am I allowed to do with this?"
// is answerable without leaving the terminal — the question that otherwise gets
// answered by guessing, because the npm page shows "SEE LICENSE IN LICENSE.md"
// and stops there.
//
// LICENSE_NAME is asserted against LICENSE.md by test/cli/license.test.ts: the
// file is the authority, this constant is a copy, and the test is what keeps the
// copy honest.
//
// Keys are sold through Paddle and issued by Keygen. The check is offline (see
// src/license/keygenKey.ts) and it does NOT gate the firewall: an unlicensed or
// expired machine is told loudly and keeps being protected. A licence check that
// can turn off prompt-injection defence is a security bug wearing a business
// model.
import {
  licenseStatus,
  saveLicenseKey,
  clearLicenseKey,
  licenseKeyPath,
  saveLicenseFile,
  clearLicenseFile,
  licenseFilePath,
  type LicenseStatus,
} from '../license/status.js'
import { readFileSync } from 'node:fs'

export const LICENSE_NAME = 'PolyForm Noncommercial License 1.0.0'
export const LICENSE_URL = 'https://polyformproject.org/licenses/noncommercial/1.0.0'
export const COMMERCIAL_URL = 'https://deversity.se/llmfw/'
export const CONTACT_EMAIL = 'peter.isberg@deversity.se'

export const SHORT_NOTICE =
  `llm-fw is licensed under the ${LICENSE_NAME} — free for noncommercial use. ` +
  `Commercial use requires a licence: ${COMMERCIAL_URL}`

/**
 * The block printed wherever an unlicensed machine is noticed: on `start`, in
 * `status`, and as a `doctor` check. It has to stand on its own — `status`
 * prints it without SHORT_NOTICE above — so it names the licence, says what
 * that licence does not cover, and gives both channels a buyer might prefer.
 * A licence prompt that offers no way to pay is just noise.
 */
export const UNLICENSED_NOTICE =
  `No licence key found — llm-fw is running unlicensed on this machine, under the\n` +
  `${LICENSE_NAME}: noncommercial use only.\n` +
  `Commercial use needs a licence. Buy one at ${COMMERCIAL_URL} or contact ${CONTACT_EMAIL}.`

export const NOTICE = `llm-fw — Copyright 2026 Peter Isberg
Licensed under the ${LICENSE_NAME}
${LICENSE_URL}

FREE — no key, no signup, no telemetry
  Any noncommercial purpose: personal projects, hobby work, private study,
  research, teaching, and use by charities, educational institutions, public
  research bodies, and government institutions.

NOT GRANTED BY THIS LICENCE — commercial use
  If llm-fw runs anywhere in a for-profit organisation's work — on a developer
  machine, in CI, or as a shared standalone server — that is commercial use and
  needs a separate licence.

  Buy one, or ask for an invoice:  ${COMMERCIAL_URL}
  Or email:                        ${CONTACT_EMAIL}

  Once you have a key:  llm-fw license --activate <key>

Full terms ship with the package as LICENSE.md.`

/** One line describing the licence state, for `status` and `doctor`. */
export function statusLine(status: LicenseStatus = licenseStatus()): string {
  const who = status.holder ? ` — ${status.holder}` : ''
  const plan = status.plan ? ` (${status.plan})` : ''
  switch (status.state) {
    case 'licensed':
      return `licensed${who}${plan}${status.expiry ? `, expires ${status.expiry.slice(0, 10)}` : ''}`
    case 'expired':
      return `EXPIRED${who} — renew at ${COMMERCIAL_URL}`
    case 'invalid':
      return `INVALID KEY — signature does not verify. Contact ${CONTACT_EMAIL}`
    case 'unverified':
      return `key present but not verifiable offline — run "llm-fw license --verify"`
    case 'unlicensed':
      return `UNLICENSED — ${CONTACT_EMAIL} or ${COMMERCIAL_URL}`
  }
}

/** The `start` banner: nothing when licensed, the notice otherwise. */
export function unlicensedBanner(status: LicenseStatus = licenseStatus()): string[] {
  if (status.state === 'licensed') return []
  const head =
    status.state === 'unlicensed'
      ? UNLICENSED_NOTICE
      : `Licence problem: ${statusLine(status)}\nContact ${CONTACT_EMAIL} or go to ${COMMERCIAL_URL}.`
  return ['', ...head.split('\n').map(l => `  ⚠  ${l}`), '']
}

function printStatus(): void {
  const status = licenseStatus()
  console.log(`Licence: ${statusLine(status)}`)
  if (status.source === 'env') console.log('  key from: LLM_FW_LICENSE_KEY')
  else if (status.source === 'file') console.log(`  key from: ${licenseKeyPath()}`)
  else if (status.source === 'offline-env') console.log('  offline licence file from: LLM_FW_LICENSE_FILE')
  else if (status.source === 'offline-file') console.log(`  offline licence file from: ${licenseFilePath()}`)
}

function handleActivate(args: string[]): void {
  const key = args[1]
  if (!key) {
    console.error('Usage: llm-fw license --activate <key>')
    process.exitCode = 1
    return
  }
  const path = saveLicenseKey(key)
  console.log(`Key saved to ${path}`)
  printStatus()
}

function handleDeactivate(): void {
  console.log(clearLicenseKey() ? `Removed ${licenseKeyPath()}` : 'No activated key on this machine.')
}

// For a licence issued directly (custom deal, complementary licence, OSS
// grant) — no Keygen policy or Paddle transaction behind it. See
// src/license/offlineLicense.ts.
function handleActivateFile(args: string[]): void {
  const filePath = args[1]
  if (!filePath) {
    console.error('Usage: llm-fw license --activate-file <path>')
    process.exitCode = 1
    return
  }
  let contents: string
  try {
    contents = readFileSync(filePath, 'utf8')
  } catch (err) {
    console.error(`Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
    return
  }
  const savedPath = saveLicenseFile(contents)
  console.log(`Offline licence file saved to ${savedPath}`)
  printStatus()
}

function handleDeactivateFile(): void {
  console.log(
    clearLicenseFile() ? `Removed ${licenseFilePath()}` : 'No activated offline licence file on this machine.',
  )
}

async function handleVerify(): Promise<void> {
  const status = licenseStatus()
  printStatus()
  if (!status.source) {
    console.log(UNLICENSED_NOTICE)
    process.exitCode = 1
    return
  }
  if (status.source === 'offline-env' || status.source === 'offline-file') {
    console.log('  offline licence files have no online counterpart to check — the signature check above is authoritative.')
    return
  }
  const { readLicenseKey } = await import('../license/status.js')
  const { verifyOnline } = await import('../license/verifyOnline.js')
  console.log('Checking with api.keygen.sh (this is the only network call llm-fw makes for licensing)...')
  const result = await verifyOnline(readLicenseKey()!.key)
  console.log(`  ${result.code ? `[${result.code}] ` : ''}${result.detail}`)
  // null (unreachable) is not a failure: an offline machine has not been shown
  // to be unlicensed, so it must not be reported as one.
  if (result.valid === false) process.exitCode = 1
}

export async function run(args: string[] = []): Promise<void> {
  switch (args[0]) {
    case '--activate':
      return handleActivate(args)
    case '--deactivate':
      return handleDeactivate()
    case '--activate-file':
      return handleActivateFile(args)
    case '--deactivate-file':
      return handleDeactivateFile()
    case '--status':
      return printStatus()
    case '--verify':
      return handleVerify()
    default:
      console.log(NOTICE)
      console.log('')
      printStatus()
  }
}
