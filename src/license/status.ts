// Where the licence lives, and what state this machine is in.
//
// Two independent channels, checked in this order — first hit wins:
//
//   1. Offline licence FILE (see offlineLicense.ts) — issued directly, with no
//      Keygen policy or Paddle transaction behind it: custom deals,
//      complementary licences, OSS grants.
//        LLM_FW_LICENSE_FILE            — path to the file (CI, containers).
//        <LLM_FW_DIR>/license-offline.lfw — what `--activate-file` writes.
//
//   2. Keygen key (see keygenKey.ts) — bought through Paddle.
//        LLM_FW_LICENSE_KEY            — CI, containers, and anything that
//                                         should not write a key to disk.
//        <LLM_FW_DIR>/license.key       — what `--activate` writes.
//
// Both are checked fully offline; a machine will normally have only one
// configured. The state is advisory. Nothing in this module exits, throws on
// a bad key/file, or blocks the firewall: an expired licence must never be the
// reason a machine loses prompt-injection protection. See src/cli/license.ts
// for how it is surfaced.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getLlmFwDir } from '../config/paths.js'
import { keygenPublicKey, offlineLicenseVerifyKey } from './account.js'
import { verifyKey, type KeyDetails } from './keygenKey.js'
import { verifyOfflineLicense, type OfflineLicenseDetails } from './offlineLicense.js'

export type LicenseState =
  /** A cryptographic key or licence file verified against the vendor public key. */
  | 'licensed'
  /** No key or licence file on this machine. */
  | 'unlicensed'
  /** Key/file present, signature good, expiry passed. */
  | 'expired'
  /** Key/file present, signature bad — forged, truncated, or from another account. */
  | 'invalid'
  /**
   * Key present but not checkable offline: either a plain (non-cryptographic)
   * Keygen key, a licence file for a different product, or a build with no
   * verify key compiled in. Reported distinctly because "we could not check"
   * is not "we checked and it failed".
   */
  | 'unverified'

export interface LicenseStatus {
  state: LicenseState
  /** Where the licence came from, for `llm-fw doctor` to name. */
  source?: 'env' | 'file' | 'offline-env' | 'offline-file'
  holder?: string
  plan?: string
  expiry?: string
  details?: KeyDetails
  offlineDetails?: OfflineLicenseDetails
}

/** Path of the activated key file. Resolved at call time so tests can relocate it. */
export function licenseKeyPath(): string {
  return join(getLlmFwDir(), 'license.key')
}

/** Path of the activated offline licence file. Resolved at call time so tests can relocate it. */
export function licenseFilePath(): string {
  return join(getLlmFwDir(), 'license-offline.lfw')
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

/** The offline licence file this machine would use, and where it came from. */
export function readOfflineLicenseFile(): { contents: string; source: 'offline-env' | 'offline-file' } | null {
  const envPath = process.env['LLM_FW_LICENSE_FILE']?.trim()
  if (envPath) {
    try {
      const contents = readFileSync(envPath, 'utf8').trim()
      if (contents) return { contents, source: 'offline-env' }
    } catch {
      /* LLM_FW_LICENSE_FILE points nowhere readable — fall through, not fatal */
    }
  }

  const path = licenseFilePath()
  try {
    const contents = readFileSync(path, 'utf8').trim()
    if (contents) return { contents, source: 'offline-file' }
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

/** Persist an offline licence file so future runs pick it up. Returns the path written. */
export function saveLicenseFile(contents: string): string {
  const dir = getLlmFwDir()
  mkdirSync(dir, { recursive: true })
  const path = licenseFilePath()
  writeFileSync(path, contents.trim() + '\n', { encoding: 'utf8', mode: 0o600 })
  return path
}

/** Remove the activated offline licence file. Returns true if one was actually there. */
export function clearLicenseFile(): boolean {
  const path = licenseFilePath()
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

/** Current licence state for this machine. Never throws. */
export function licenseStatus(now: Date = new Date()): LicenseStatus {
  const offlineFound = readOfflineLicenseFile()
  if (offlineFound) {
    const details = verifyOfflineLicense(offlineFound.contents, offlineLicenseVerifyKey(), now)
    const common = {
      source: offlineFound.source,
      holder: details.licensee,
      plan: details.plan,
      expiry: details.expires,
      offlineDetails: details,
    }
    switch (details.verdict) {
      case 'valid':
        return { state: 'licensed', ...common }
      case 'expired':
        return { state: 'expired', ...common }
      case 'signature_invalid':
        return { state: 'invalid', ...common }
      // A file for another product, an unparseable file, or a build with no
      // offline verify key compiled in — all "unknown", never "forged".
      case 'malformed':
      case 'wrong_product':
      case 'unconfigured':
        return { state: 'unverified', ...common }
    }
  }

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
