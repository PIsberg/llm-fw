// Offline verification of a Keygen cryptographic licence key (ED25519_SIGN).
//
// Why offline: llm-fw is a firewall that sits in front of every LLM call a
// machine makes, and the README promises no telemetry. A licence check that
// phones home on every start would be both a new failure mode for the thing
// meant to keep working, and a broken promise. Keygen's ED25519_SIGN keys carry
// their own payload and signature, so a key can be checked with nothing but the
// account's public verify key — no network, works air-gapped.
//
// Key shape (Keygen docs, "Cryptographic license keys"):
//
//   key/<base64url(dataset)>.<base64url(ed25519 signature)>
//
// The signed message is the ENTIRE first half INCLUDING the `key/` prefix, not
// the decoded dataset. Signing the decoded payload instead is the classic way to
// get a verifier that rejects every real key.
//
// Everything here is pure: no fs, no env, no network. That is what makes the
// failure modes testable — see test/license/keygenKey.test.ts.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

/** Why a key is not usable, or that it is. */
export type KeyVerdict =
  | 'valid'
  /** Signature check failed: forged, corrupted, or issued by another account. */
  | 'forged'
  /** Not a Keygen ED25519_SIGN key at all (wrong prefix / missing signature). */
  | 'malformed'
  /** Signature is good but the embedded expiry has passed. */
  | 'expired'
  /** This build has no account public key compiled in, so nothing can be checked. */
  | 'unconfigured'

export interface KeyDetails {
  verdict: KeyVerdict
  /** Who the licence names, when the dataset carries it. */
  holder?: string | undefined
  /** Policy / plan name, when the dataset carries it. */
  plan?: string | undefined
  /** ISO-8601 expiry from the dataset; absent means perpetual. */
  expiry?: string | undefined
  /** The decoded dataset, for `--verbose` output and for tests to assert on. */
  dataset?: unknown
}

const SCHEME_PREFIX = 'key/'

/**
 * Wrap a raw 32-byte Ed25519 public key in the SPKI DER envelope node:crypto
 * requires. Node has no "raw Ed25519 public key" import, and the envelope is a
 * fixed 12-byte header for this curve, so prepending it is exact rather than a
 * heuristic.
 */
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

/**
 * Pull the human-facing fields out of Keygen's embedded dataset.
 *
 * The dataset is whatever the issuing policy embeds, so this reads defensively:
 * several plausible paths are tried and anything missing is simply left off,
 * rather than the whole key being rejected because a field moved. A key that
 * verifies is valid even if we cannot name its holder.
 */
function readDataset(dataset: unknown): Pick<KeyDetails, 'holder' | 'plan' | 'expiry'> {
  if (typeof dataset !== 'object' || dataset === null) return {}
  const d = dataset as Record<string, unknown>
  const licenseAttrs = (d['license'] as Record<string, unknown> | undefined)?.['attributes'] as
    | Record<string, unknown>
    | undefined
  const ownerAttrs = ((d['owner'] ?? d['user']) as Record<string, unknown> | undefined)?.[
    'attributes'
  ] as Record<string, unknown> | undefined
  const policyAttrs = (d['policy'] as Record<string, unknown> | undefined)?.['attributes'] as
    | Record<string, unknown>
    | undefined

  const str = (...candidates: unknown[]): string | undefined => {
    for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim()
    return undefined
  }

  return {
    holder: str(d['holder'], d['name'], licenseAttrs?.['name'], ownerAttrs?.['email'], ownerAttrs?.['name']),
    plan: str(d['plan'], d['tier'], policyAttrs?.['name']),
    expiry: str(d['expiry'], d['exp'], licenseAttrs?.['expiry']),
  }
}

/**
 * Verify a Keygen ED25519_SIGN key against an account public key.
 *
 * `publicKeyHex` empty (an unconfigured build) yields `unconfigured` — never
 * `forged`. Telling a paying customer their key is fake because the build forgot
 * its own verify key is the worst outcome available here.
 *
 * `now` is injectable so the expiry boundary can be tested without waiting.
 */
export function verifyKey(key: string, publicKeyHex: string, now: Date = new Date()): KeyDetails {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) return { verdict: 'unconfigured' }

  const trimmed = key.trim()
  if (!trimmed.startsWith(SCHEME_PREFIX)) return { verdict: 'malformed' }

  // Split on the LAST dot: base64url never contains one, but splitting on the
  // first would silently mangle any future scheme that adds a segment.
  const dot = trimmed.lastIndexOf('.')
  if (dot <= SCHEME_PREFIX.length) return { verdict: 'malformed' }

  const signingData = trimmed.slice(0, dot)
  const encodedSignature = trimmed.slice(dot + 1)
  if (!encodedSignature) return { verdict: 'malformed' }

  let signature: Buffer
  try {
    signature = Buffer.from(encodedSignature, 'base64url')
  } catch {
    return { verdict: 'malformed' }
  }
  if (signature.length !== 64) return { verdict: 'malformed' }

  let signatureOk: boolean
  try {
    signatureOk = cryptoVerify(
      null,
      Buffer.from(signingData, 'utf8'),
      ed25519PublicKeyFromHex(publicKeyHex),
      signature,
    )
  } catch {
    return { verdict: 'forged' }
  }
  if (!signatureOk) return { verdict: 'forged' }

  // Only decode the payload AFTER the signature checks out, so a forged key can
  // never steer the parser.
  let dataset: unknown
  const rawDataset = Buffer.from(signingData.slice(SCHEME_PREFIX.length), 'base64url').toString('utf8')
  try {
    dataset = JSON.parse(rawDataset)
  } catch {
    dataset = rawDataset
  }

  const fields = readDataset(dataset)
  if (fields.expiry) {
    const expiresAt = new Date(fields.expiry)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) {
      return { verdict: 'expired', dataset, ...fields }
    }
  }

  return { verdict: 'valid', dataset, ...fields }
}
