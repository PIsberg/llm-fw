// Where the licence key lives, and what state this machine is in.
//
// Resolution order, first hit wins:
//   1. LLM_FW_LICENSE_KEY   — CI, containers, and anything that should not write
//                             a key to disk.
//   2. <LLM_FW_DIR>/license.key — what `llm-fw license --activate <key>` writes.
//
// The state is advisory. Nothing in this module exits, throws on a bad key, or
// blocks the firewall: an expired key must never be the reason a machine loses
// prompt-injection protection. See src/cli/license.ts for how it is surfaced.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getLlmFwDir } from '../config/paths.js'
import { keygenPublicKey } from './account.js'
import { verifyKey, type KeyDetails } from './keygenKey.js'

export type LicenseState =
  /** A cryptographic key verified against the account public key. */
  | 'licensed'
  /** No key on this machine. */
  | 'unlicensed'
  /** Key present, signature good, expiry passed. */
  | 'expired'
  /** Key present, signature bad — forged, truncated, or from another account. */
  | 'invalid'
  /**
   * Key present but not checkable offline: either a plain (non-cryptographic)
   * Keygen key, or a build with no account public key compiled in. Reported
   * distinctly because "we could not check" is not "we checked and it failed".
   */
  | 'unverified'

export interface LicenseStatus {
  state: LicenseState
  /** Where the key came from, for `llm-fw doctor` to name. */
  source?: 'env' | 'file'
  holder?: string
  plan?: string
  expiry?: string
  details?: KeyDetails
}

/** Path of the activated key file. Resolved at call time so tests can relocate it. */
export function licenseKeyPath(): string {
  return join(getLlmFwDir(), 'license.key')
}

/** The key this machine would use, and where it came from. */
export function readLicenseKey(): { key: string; source: 'env' | 'file' } | null {
  const fromEnv = process.env['LLM_FW_LICENSE_KEY']?.trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }

  const path = licenseKeyPath()
  try {
    const contents = readFileSync(path, 'utf8').trim()
    if (contents) return { key: contents, source: 'file' }
  } catch {
    /* not activated on this machine */
  }
  return null
}

/** Persist a key so future runs pick it up. Returns the path written. */
export function saveLicenseKey(key: string): string {
  const dir = getLlmFwDir()
  mkdirSync(dir, { recursive: true })
  const path = licenseKeyPath()
  // 0o600: the key is a bearer credential — anyone who can read it can use the
  // licence. Ignored on Windows, which is why it is a mode and not a promise.
  writeFileSync(path, key.trim() + '\n', { encoding: 'utf8', mode: 0o600 })
  return path
}

/** Remove the activated key. Returns true if a key was actually there. */
export function clearLicenseKey(): boolean {
  const path = licenseKeyPath()
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

/** Current licence state for this machine. Never throws. */
export function licenseStatus(now: Date = new Date()): LicenseStatus {
  const found = readLicenseKey()
  if (!found) return { state: 'unlicensed' }

  const details = verifyKey(found.key, keygenPublicKey(), now)
  const common = {
    source: found.source,
    holder: details.holder,
    plan: details.plan,
    expiry: details.expiry,
    details,
  }

  switch (details.verdict) {
    case 'valid':
      return { state: 'licensed', ...common }
    case 'expired':
      return { state: 'expired', ...common }
    case 'forged':
      return { state: 'invalid', ...common }
    // A plain Keygen key or an unconfigured build. Both mean "unknown", and an
    // unknown key is treated as present-in-good-faith: the warning still prints,
    // but it does not call the holder a forger.
    case 'malformed':
    case 'unconfigured':
      return { state: 'unverified', ...common }
  }
}

/** True when the machine should be shown the buy-a-licence notice. */
export function needsLicenseNotice(status: LicenseStatus): boolean {
  return status.state !== 'licensed'
}
