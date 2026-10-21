// Paddle Billing webhook verification and Keygen ED25519_SIGN licence issuance.
//
// Paddle handles checkout and billing; Keygen mints and signs the cryptographic
// key (`key/<base64url(dataset)>.<base64url(ed25519 signature)>`). This module
// verifies Paddle's `Paddle-Signature` HMAC-SHA256 header in constant time,
// parses `transaction.completed` payloads, calls Keygen's JSON:API to issue a
// signed key under the configured policy, and verifies the returned key offline
// against `keygenPublicKey()` before handing it back.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { keygenAccountId, keygenPublicKey } from './account.js'
import { verifyKey } from './keygenKey.js'

export interface PaddleSignatureOptions {
  now?: Date | undefined
  /** Max allowed age (in seconds) of the webhook timestamp. Default: 300s (5 min). */
  maxAgeSeconds?: number | undefined
}

export type PaddleSignatureResult =
  | { valid: true; timestamp: number }
  | { valid: false; reason: 'malformed-header' | 'timestamp-expired' | 'signature-mismatch' }

/**
 * Verify a Paddle Billing `Paddle-Signature` header (`ts=<unix>;h1=<hex>[;h1=<hex>]`)
 * against the raw UTF-8 request body and the endpoint's webhook secret.
 */
export function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  options: PaddleSignatureOptions = {},
): PaddleSignatureResult {
  if (!signatureHeader || !webhookSecret) {
    return { valid: false, reason: 'malformed-header' }
  }

  let tsStr: string | undefined
  const h1List: string[] = []
  for (const part of signatureHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k === 'ts' && /^\d+$/.test(v)) tsStr = v
    else if (k === 'h1' && /^[0-9a-f]{64}$/i.test(v)) h1List.push(v.toLowerCase())
  }

  if (!tsStr || h1List.length === 0) {
    return { valid: false, reason: 'malformed-header' }
  }

  const timestamp = Number(tsStr)
  const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000)
  const maxAge = options.maxAgeSeconds ?? 300
  if (nowSec - timestamp > maxAge || timestamp - nowSec > 60) {
    return { valid: false, reason: 'timestamp-expired' }
  }

  const expected = createHmac('sha256', webhookSecret).update(`${tsStr}:${rawBody}`, 'utf8').digest()
  for (const candidateHex of h1List) {
    const candidate = Buffer.from(candidateHex, 'hex')
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { valid: true, timestamp }
    }
  }

  return { valid: false, reason: 'signature-mismatch' }
}

export type ParsedPaddleEvent =
  | {
      actionable: true
      eventType: string
      transactionId: string
      customerId?: string | undefined
      customerEmail?: string | undefined
      customerName?: string | undefined
      plan?: string | undefined
    }
  | {
      actionable: false
      reason: 'malformed-json' | 'ignored-event-type' | 'missing-transaction-id'
      eventType?: string | undefined
    }

function pickStr(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * Parse a verified Paddle Billing webhook payload and extract the customer and
 * plan metadata needed to issue a Keygen licence on `transaction.completed`.
 */
export function parsePaddleTransactionEvent(rawBody: string): ParsedPaddleEvent {
  let root: unknown
  try {
    root = JSON.parse(rawBody)
  } catch {
    return { actionable: false, reason: 'malformed-json' }
  }
  if (typeof root !== 'object' || root === null) {
    return { actionable: false, reason: 'malformed-json' }
  }

  const evt = root as Record<string, unknown>
  const eventType = pickStr(evt['event_type'])
  if (eventType !== 'transaction.completed') {
    return { actionable: false, reason: 'ignored-event-type', eventType }
  }

  const data = (evt['data'] ?? {}) as Record<string, unknown>
  const transactionId = pickStr(data['id'])
  if (!transactionId) {
    return { actionable: false, reason: 'missing-transaction-id', eventType }
  }

  const customer = (data['customer'] ?? {}) as Record<string, unknown>
  const billingDetails = (data['billing_details'] ?? {}) as Record<string, unknown>
  const customData = (data['custom_data'] ?? {}) as Record<string, unknown>
  const items = Array.isArray(data['items']) ? (data['items'] as Record<string, unknown>[]) : []
  const firstPrice = ((items[0] ?? {})['price'] ?? {}) as Record<string, unknown>

  const customerId = pickStr(data['customer_id'], customer['id'])
  const customerEmail = pickStr(customer['email'], customData['email'], billingDetails['email'])
  const customerName = pickStr(customer['name'], customData['name'], billingDetails['name'], customerEmail)
  const plan = pickStr(firstPrice['name'], firstPrice['description'], customData['plan'], firstPrice['id'])

  return {
    actionable: true,
    eventType,
    transactionId,
    ...(customerId ? { customerId } : {}),
    ...(customerEmail ? { customerEmail } : {}),
    ...(customerName ? { customerName } : {}),
    ...(plan ? { plan } : {}),
  }
}

export interface IssueKeygenLicenseOptions {
  accountId?: string | undefined
  policyId: string
  apiToken: string
  holderName?: string | undefined
  customerEmail?: string | undefined
  transactionId: string
  plan?: string | undefined
  publicKeyHex?: string | undefined
  apiBaseUrl?: string | undefined
  fetchImpl?: typeof fetch | undefined
  now?: Date | undefined
}

export interface IssuedKeygenLicense {
  licenseId: string
  licenseKey: string
  holder?: string | undefined
  plan?: string | undefined
  expiry?: string | undefined
  activationCommand: string
}

/**
 * Mint a new cryptographic licence in Keygen under `policyId` and verify the
 * returned `ED25519_SIGN` key offline against the account's public key before
 * returning it.
 */
export async function issueKeygenLicense(options: IssueKeygenLicenseOptions): Promise<IssuedKeygenLicense> {
  const accountId = options.accountId ?? keygenAccountId()
  const publicKeyHex = options.publicKeyHex ?? keygenPublicKey()
  const baseUrl = (options.apiBaseUrl ?? 'https://api.keygen.sh').replace(/\/+$/, '')
  const fetchFn = options.fetchImpl ?? fetch

  const metadata: Record<string, string> = {
    paddleTransactionId: options.transactionId,
  }
  if (options.customerEmail) metadata['email'] = options.customerEmail
  if (options.plan) metadata['plan'] = options.plan

  const res = await fetchFn(`${baseUrl}/v1/accounts/${encodeURIComponent(accountId)}/licenses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'licenses',
        attributes: {
          ...(options.holderName ? { name: options.holderName } : {}),
          metadata,
        },
        relationships: {
          policy: {
            data: { type: 'policies', id: options.policyId },
          },
        },
      },
    }),
  })

  if (!res.ok) {
    throw new Error(`Keygen license creation failed with HTTP ${res.status}`)
  }

  const body = (await res.json()) as Record<string, unknown>
  const data = (body['data'] ?? {}) as Record<string, unknown>
  const attrs = (data['attributes'] ?? {}) as Record<string, unknown>
  const licenseId = pickStr(data['id'])
  const licenseKey = pickStr(attrs['key'])
  if (!licenseId || !licenseKey) {
    throw new Error('Keygen response missing data.id or data.attributes.key')
  }

  const check = verifyKey(licenseKey, publicKeyHex, options.now)
  if (check.verdict !== 'valid') {
    throw new Error(`Keygen returned a key that failed offline verification: ${check.verdict}`)
  }

  const holder = check.holder ?? options.holderName
  const plan = check.plan ?? options.plan
  const expiry = check.expiry ?? pickStr(attrs['expiry'])

  return {
    licenseId,
    licenseKey,
    ...(holder ? { holder } : {}),
    ...(plan ? { plan } : {}),
    ...(expiry ? { expiry } : {}),
    activationCommand: `llm-fw license --activate ${licenseKey}`,
  }
}

export interface FulfillPaddleWebhookOptions {
  rawBody: string
  signatureHeader: string
  webhookSecret: string
  keygenAccountId?: string | undefined
  keygenPolicyId: string
  keygenApiToken: string
  keygenPublicKeyHex?: string | undefined
  fetchImpl?: typeof fetch | undefined
  now?: Date | undefined
}

export type FulfillPaddleWebhookResult =
  | ({
      status: 'issued'
      transactionId: string
      customerEmail?: string | undefined
    } & IssuedKeygenLicense)
  | { status: 'ignored'; reason: string; eventType?: string | undefined }
  | { status: 'rejected'; reason: string }

/**
 * End-to-end Paddle webhook handler: verify `Paddle-Signature`, filter for
 * `transaction.completed`, and issue + offline-verify a Keygen key.
 */
export async function fulfillPaddleWebhook(
  options: FulfillPaddleWebhookOptions,
): Promise<FulfillPaddleWebhookResult> {
  const sig = verifyPaddleSignature(options.rawBody, options.signatureHeader, options.webhookSecret, {
    now: options.now,
  })
  if (!sig.valid) {
    return { status: 'rejected', reason: sig.reason }
  }

  const parsed = parsePaddleTransactionEvent(options.rawBody)
  if (!parsed.actionable) {
    if (parsed.reason === 'ignored-event-type') {
      return { status: 'ignored', reason: parsed.reason, eventType: parsed.eventType }
    }
    return { status: 'rejected', reason: parsed.reason }
  }

  const issued = await issueKeygenLicense({
    accountId: options.keygenAccountId,
    policyId: options.keygenPolicyId,
    apiToken: options.keygenApiToken,
    holderName: parsed.customerName,
    customerEmail: parsed.customerEmail,
    transactionId: parsed.transactionId,
    plan: parsed.plan,
    publicKeyHex: options.keygenPublicKeyHex,
    fetchImpl: options.fetchImpl,
    now: options.now,
  })

  return {
    status: 'issued',
    transactionId: parsed.transactionId,
    ...(parsed.customerEmail ? { customerEmail: parsed.customerEmail } : {}),
    ...issued,
  }
}
