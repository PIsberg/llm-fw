// Offline verification of a self-issued licence FILE — a second, Keygen/Paddle
// independent path for licences Peter hands out directly: custom deals,
// complementary licences, OSS grants. llm-fw's normal Keygen key is already
// fully offline-verified (see keygenKey.ts), so this exists for the case where
// there is no Keygen policy/transaction behind the licence at all.
//
// File shape, one line:
//
//   LFW1.<base64url(payload)>.<base64url(ed25519 signature)>
//
// The payload is UTF-8 `key=value` lines carrying `product`, `licensee`,
// `issued`, `expires` (ISO date) and optionally `plan`. The signature is
// Ed25519 over the exact payload bytes, verified against the vendor public key
// embedded in account.ts — no network, no Keygen account, no clock beyond the
// machine's own.
//
// Files are issued with scripts/issue-offline-license.ts.
//
// Everything here is pure: no fs, no env, no network — see keygenKey.ts for why
// that split matters (testability of every failure mode).

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

export type OfflineLicenseVerdict =
  | 'valid'
  /** Not the `LFW1.<payload>.<signature>` shape at all. */
  | 'malformed'
  /** Signature does not match the payload: forged, corrupted, or a different signing key. */
  | 'signature_invalid'
  /** Signed by the right key, but for a different product. */
  | 'wrong_product'
  /** Signature good, but the embedded expiry has passed. */
  | 'expired'
  /** This build has no offline-licence verify key compiled in. */
  | 'unconfigured'

export interface OfflineLicenseDetails {
  verdict: OfflineLicenseVerdict
  licensee?: string | undefined
  plan?: string | undefined
  issued?: string | undefined
  expires?: string | undefined
}

const FORMAT_PREFIX = 'LFW1'
const PRODUCT = 'llm-fw'

/** Wrap a raw 32-byte Ed25519 public key in the SPKI DER envelope node:crypto requires. */
function ed25519PublicKeyFromHex(hex: string) {
  const raw = Buffer.from(hex, 'hex')
  if (raw.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.length}`)
  const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex')
  return createPublicKey({
    key: Buffer.concat([spkiHeader, raw]),
    format: 'der',
    type: 'spki',
  })
}

/** Parse `key=value` lines. Unknown keys are ignored so the format can grow. */
function parsePayload(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    fields[line.slice(0, eq).trim()] = line.slice(eq + 1)
  }
  return fields
}

/**
 * Verify an offline licence file's contents against a vendor public key.
 *
 * `verifyKeyHex` empty (an unconfigured build) yields `unconfigured` — never
 * `signature_invalid`. Same reasoning as keygenKey.ts: a build that forgot its
 * own verify key must not accuse the holder of forgery.
 *
 * `now` is injectable so the expiry boundary can be tested without waiting.
 */
export function verifyOfflineLicense(
  fileContents: string,
  verifyKeyHex: string,
  now: Date = new Date(),
): OfflineLicenseDetails {
  if (!/^[0-9a-f]{64}$/i.test(verifyKeyHex)) return { verdict: 'unconfigured' }

  const trimmed = fileContents.trim()
  const firstDot = trimmed.indexOf('.')
  const secondDot = firstDot < 0 ? -1 : trimmed.indexOf('.', firstDot + 1)
  const extraDot = secondDot < 0 ? -1 : trimmed.indexOf('.', secondDot + 1)
  if (firstDot < 0 || secondDot < 0 || extraDot >= 0 || trimmed.slice(0, firstDot) !== FORMAT_PREFIX) {
    return { verdict: 'malformed' }
  }

  let payloadBytes: Buffer
  let signature: Buffer
  try {
    payloadBytes = Buffer.from(trimmed.slice(firstDot + 1, secondDot), 'base64url')
    signature = Buffer.from(trimmed.slice(secondDot + 1), 'base64url')
  } catch {
    return { verdict: 'malformed' }
  }
  if (payloadBytes.length === 0 || signature.length !== 64) return { verdict: 'malformed' }

  let signatureOk: boolean
  try {
    signatureOk = cryptoVerify(null, payloadBytes, ed25519PublicKeyFromHex(verifyKeyHex), signature)
  } catch {
    return { verdict: 'signature_invalid' }
  }
  if (!signatureOk) return { verdict: 'signature_invalid' }

  // Only parse the payload AFTER the signature checks out, so a forged file can
  // never steer the parser.
  const fields = parsePayload(payloadBytes.toString('utf8'))
  if (fields['product'] !== PRODUCT) return { verdict: 'wrong_product' }

  const licensee = fields['licensee']?.trim()
  const expiresRaw = fields['expires']?.trim()
  if (!licensee || !expiresRaw) return { verdict: 'malformed' }

  const details: OfflineLicenseDetails = {
    verdict: 'valid',
    licensee,
    expires: expiresRaw,
    issued: fields['issued']?.trim() || undefined,
    plan: fields['plan']?.trim() || undefined,
  }

  const expiresAt = new Date(`${expiresRaw}T23:59:59.999Z`)
  if (Number.isNaN(expiresAt.getTime())) return { verdict: 'malformed' }
  if (expiresAt.getTime() < now.getTime()) return { ...details, verdict: 'expired' }

  return details
}
