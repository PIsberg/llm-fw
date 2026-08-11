// The Keygen account this build's licence keys are issued against.
//
// Keys are sold through Paddle; Paddle's webhook creates the licence in Keygen,
// and Keygen hands the buyer a key signed with the account's Ed25519 private
// key. This file holds the two public halves the CLI needs to check a key
// WITHOUT a network call:
//
//   accountId       — the account UUID, only needed for the opt-in online
//                     `llm-fw license --verify` round-trip.
//   publicKey       — the account's Ed25519 verify key, hex, 64 chars. Copy it
//                     from Keygen: Settings → Account → Public key.
//
// Both are PUBLIC values. Nothing secret belongs in this file, and the signing
// private key must never be in this repository — it lives with whoever issues
// keys. Publishing the verify key is the point: it is what lets a customer's
// machine check a key offline.
//
// Until they are filled in, offline verification cannot run: verifyKey() reports
// `unconfigured` rather than pretending a key is bad, so a shipped-but-
// unconfigured build never accuses a paying customer of piracy.

const KEYGEN_ACCOUNT_ID = 'e32e3ad2-6680-45ea-81e0-df983822fdd0'
const KEYGEN_PUBLIC_KEY = 'b3e5aa9ce5b26e60f85bb144d8f8a261245f266b14d8dd34d0b7bee4ce398010'

/** Keygen account UUID. Override for staging with LLM_FW_KEYGEN_ACCOUNT. */
export function keygenAccountId(): string {
  return process.env['LLM_FW_KEYGEN_ACCOUNT'] || KEYGEN_ACCOUNT_ID
}

/** Account Ed25519 public key, hex-encoded. Override with LLM_FW_KEYGEN_PUBLIC_KEY. */
export function keygenPublicKey(): string {
  return process.env['LLM_FW_KEYGEN_PUBLIC_KEY'] || KEYGEN_PUBLIC_KEY
}

/**
 * True once this build can verify keys offline. Used to tell "this key cannot be
 * checked because the build has no verify key" apart from "this key is not a
 * cryptographic key" — two very different things to say to a customer.
 */
export function isKeygenConfigured(): boolean {
  return /^[0-9a-f]{64}$/i.test(keygenPublicKey())
}
