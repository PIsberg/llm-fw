// Opt-in online validation against Keygen.
//
// This is the ONLY code path in llm-fw that talks to a licensing server, and it
// runs only when a human types `llm-fw license --verify`. Nothing calls it on
// start, on a schedule, or in the background — the offline signature check in
// keygenKey.ts covers the normal path, so the "no telemetry" promise in the
// README stays true for anyone who never runs this command.
//
// It exists because a signature cannot answer two questions: has this key been
// revoked (refund, chargeback, abuse), and is a plain non-cryptographic key
// genuine. Those need the server.
//
// Endpoint: the unauthenticated "validate by key" action, which takes the key in
// the body rather than a bearer token:
//   POST https://api.keygen.sh/v1/accounts/<account>/licenses/actions/validate-key
//   { "meta": { "key": "<key>" } }
// It answers with meta.valid, meta.code (VALID, EXPIRED, SUSPENDED, BANNED, …)
// and meta.detail.

import { keygenAccountId } from './account.js'

export interface OnlineResult {
  /** false when Keygen says no; null when we could not reach it at all. */
  valid: boolean | null
  /** Keygen's machine-readable code, e.g. VALID / EXPIRED / SUSPENDED / NOT_FOUND. */
  code?: string | undefined
  /** Keygen's human-readable sentence, or the reason we could not ask. */
  detail: string
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Ask Keygen whether a key is currently valid.
 *
 * Network failure returns `valid: null`, never `false`: an offline laptop is not
 * evidence of an invalid licence, and treating it as such is how licence checks
 * end up locking out paying customers on a plane.
 */
export async function verifyOnline(key: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<OnlineResult> {
  const account = keygenAccountId()
  if (!account) {
    return { valid: null, detail: 'This build has no Keygen account configured, so it cannot validate online.' }
  }

  const url = `https://api.keygen.sh/v1/accounts/${encodeURIComponent(account)}/licenses/actions/validate-key`
  const signal = AbortSignal.timeout(timeoutMs)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
      },
      body: JSON.stringify({ meta: { key: key.trim() } }),
      signal,
    })
  } catch (err) {
    return { valid: null, detail: `Could not reach api.keygen.sh: ${(err as Error).message}` }
  }

  let body: { meta?: { valid?: boolean; code?: string; detail?: string }; errors?: { detail?: string }[] }
  try {
    body = (await response.json()) as typeof body
  } catch {
    return { valid: null, detail: `Keygen replied ${response.status} with a body that was not JSON.` }
  }

  if (body.errors?.length) {
    return { valid: false, detail: body.errors.map(e => e.detail).filter(Boolean).join('; ') || `Keygen replied ${response.status}.` }
  }

  const meta = body.meta ?? {}
  if (typeof meta.valid !== 'boolean') {
    return { valid: null, detail: `Keygen replied ${response.status} without a validation verdict.` }
  }

  return {
    valid: meta.valid,
    code: meta.code,
    detail: meta.detail ?? (meta.valid ? 'Licence is valid.' : 'Licence is not valid.'),
  }
}
