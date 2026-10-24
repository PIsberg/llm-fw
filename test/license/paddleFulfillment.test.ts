import { describe, it, expect, vi } from 'vitest'
import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import {
  verifyPaddleSignature,
  parsePaddleTransactionEvent,
  issueKeygenLicense,
  fulfillPaddleWebhook,
} from '../../src/license/paddleFulfillment.js'

function signPaddle(rawBody: string, secret: string, ts: number): string {
  const mac = createHmac('sha256', secret).update(`${ts}:${rawBody}`, 'utf8').digest('hex')
  return `ts=${ts};h1=${mac}`
}

function makeSignedKeygenKey(dataset: Record<string, unknown>) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const publicKeyHex = spki.subarray(spki.length - 32).toString('hex')
  const signingData = `key/${Buffer.from(JSON.stringify(dataset), 'utf8').toString('base64url')}`
  const sig = cryptoSign(null, Buffer.from(signingData, 'utf8'), privateKey).toString('base64url')
  return { key: `${signingData}.${sig}`, publicKeyHex }
}

describe('Paddle -> Keygen license fulfilment', () => {
  const secret = 'pdl_ntfset_test_secret_123456'
  const now = new Date('2026-10-21T12:00:00.000Z')
  const nowSec = Math.floor(now.getTime() / 1000)

  describe('verifyPaddleSignature', () => {
    it('accepts a valid Paddle-Signature within the replay window', () => {
      const body = '{"event_type":"transaction.completed"}'
      const header = signPaddle(body, secret, nowSec - 30)
      expect(verifyPaddleSignature(body, header, secret, { now })).toEqual({
        valid: true,
        timestamp: nowSec - 30,
      })
    })

    it('accepts when a rotated secondary h1 signature matches', () => {
      const body = '{"event_type":"transaction.completed"}'
      const goodMac = createHmac('sha256', secret).update(`${nowSec}:${body}`, 'utf8').digest('hex')
      const staleMac = 'a'.repeat(64)
      const header = `ts=${nowSec};h1=${staleMac};h1=${goodMac}`
      expect(verifyPaddleSignature(body, header, secret, { now }).valid).toBe(true)
    })

    it('rejects a tampered payload, wrong secret, malformed header, or replayed timestamp', () => {
      const body = '{"event_type":"transaction.completed"}'
      const header = signPaddle(body, secret, nowSec)
      expect(verifyPaddleSignature(body + ' ', header, secret, { now })).toEqual({
        valid: false,
        reason: 'signature-mismatch',
      })
      expect(verifyPaddleSignature(body, header, 'wrong_secret', { now })).toEqual({
        valid: false,
        reason: 'signature-mismatch',
      })
      expect(verifyPaddleSignature(body, 'invalid-header', secret, { now })).toEqual({
        valid: false,
        reason: 'malformed-header',
      })
      const expiredHeader = signPaddle(body, secret, nowSec - 600)
      expect(verifyPaddleSignature(body, expiredHeader, secret, { now, maxAgeSeconds: 300 })).toEqual({
        valid: false,
        reason: 'timestamp-expired',
      })
    })
  })

  describe('parsePaddleTransactionEvent', () => {
    it('extracts customer, plan, and transaction id from transaction.completed', () => {
      const raw = JSON.stringify({
        event_id: 'evt_01',
        event_type: 'transaction.completed',
        data: {
          id: 'txn_01hxyz',
          customer_id: 'ctm_01',
          customer: { email: 'billing@acme.io', name: 'Acme Corp' },
          items: [{ price: { id: 'pri_01', name: 'Team Annual' }, quantity: 1 }],
        },
      })
      expect(parsePaddleTransactionEvent(raw)).toEqual({
        actionable: true,
        eventType: 'transaction.completed',
        transactionId: 'txn_01hxyz',
        customerId: 'ctm_01',
        customerEmail: 'billing@acme.io',
        customerName: 'Acme Corp',
        plan: 'Team Annual',
      })
    })

    it('marks non-completed events as non-actionable without throwing', () => {
      const raw = JSON.stringify({
        event_type: 'transaction.updated',
        data: { id: 'txn_01hxyz' },
      })
      expect(parsePaddleTransactionEvent(raw)).toEqual({
        actionable: false,
        reason: 'ignored-event-type',
        eventType: 'transaction.updated',
      })
    })
  })

  describe('issueKeygenLicense & fulfillPaddleWebhook', () => {
    it('mints a Keygen license via JSON:API and verifies the returned Ed25519 key offline', async () => {
      const { key, publicKeyHex } = makeSignedKeygenKey({
        holder: 'Acme Corp',
        plan: 'Team Annual',
        expiry: '2027-10-21T00:00:00.000Z',
      })

      const fetchMock = vi.fn()
        // The lookup for an existing licence on this transaction: none.
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              data: {
                id: 'lic_01',
                type: 'licenses',
                attributes: {
                  key,
                  name: 'Acme Corp',
                  expiry: '2027-10-21T00:00:00.000Z',
                },
              },
            }),
        })

      const payload = JSON.stringify({
        event_type: 'transaction.completed',
        data: {
          id: 'txn_01hxyz',
          customer_id: 'ctm_01',
          customer: { email: 'billing@acme.io', name: 'Acme Corp' },
          items: [{ price: { id: 'pri_01', name: 'Team Annual' } }],
        },
      })
      const sigHeader = signPaddle(payload, secret, nowSec)

      const result = await fulfillPaddleWebhook({
        rawBody: payload,
        signatureHeader: sigHeader,
        webhookSecret: secret,
        keygenAccountId: 'e32e3ad2-6680-45ea-81e0-df983822fdd0',
        keygenPolicyId: 'pol_commercial_annual',
        keygenApiToken: 'prod-token-xyz',
        keygenPublicKeyHex: publicKeyHex,
        fetchImpl: fetchMock as unknown as typeof fetch,
        now,
      })

      expect(result.status).toBe('issued')
      if (result.status === 'issued') {
        expect(result.licenseId).toBe('lic_01')
        expect(result.licenseKey).toBe(key)
        expect(result.transactionId).toBe('txn_01hxyz')
        expect(result.customerEmail).toBe('billing@acme.io')
        expect(result.activationCommand).toBe(`llm-fw license --activate ${key}`)
      }

      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(lookupUrl).toBe('https://api.keygen.sh/v1/accounts/e32e3ad2-6680-45ea-81e0-df983822fdd0/licenses?metadata[paddleTransactionId]=txn_01hxyz&limit=1')
      expect(lookupInit.method).toBe('GET')
      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
      expect(url).toBe('https://api.keygen.sh/v1/accounts/e32e3ad2-6680-45ea-81e0-df983822fdd0/licenses')
      expect(init.method).toBe('POST')
      const sentBody = JSON.parse(init.body as string) as Record<string, unknown>
      expect(sentBody).toMatchObject({
        data: {
          type: 'licenses',
          attributes: {
            name: 'Acme Corp',
            metadata: {
              paddleTransactionId: 'txn_01hxyz',
              email: 'billing@acme.io',
              plan: 'Team Annual',
            },
          },
          relationships: {
            policy: {
              data: { type: 'policies', id: 'pol_commercial_annual' },
            },
          },
        },
      })
    })

    it('rejects when Keygen returns a key that fails offline signature verification', async () => {
      const { publicKeyHex } = makeSignedKeygenKey({ holder: 'Acme' })
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () =>
          Promise.resolve({
            data: {
              id: 'lic_bad',
              attributes: { key: 'key/not-a-valid-signed-key.aaaa' },
            },
          }),
      })

      await expect(
        issueKeygenLicense({
          accountId: 'acc_1',
          policyId: 'pol_1',
          apiToken: 'tok_1',
          holderName: 'Acme',
          customerEmail: 'billing@acme.io',
          transactionId: 'txn_1',
          publicKeyHex,
          fetchImpl: fetchMock as unknown as typeof fetch,
          now,
        }),
      ).rejects.toThrow(/failed offline verification/i)
    })

    // #466: the operator tool created a licence on every run, so running it
    // twice for one purchase issued two valid keys.
    it('returns the licence already issued for the transaction instead of minting a second', async () => {
      const { key, publicKeyHex } = makeSignedKeygenKey({ holder: 'Acme Corp', plan: 'Team Annual' })
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ id: 'lic_existing', type: 'licenses', attributes: { key, name: 'Acme Corp' } }] }),
      })

      const issued = await issueKeygenLicense({
        accountId: 'acc_1',
        policyId: 'pol_1',
        apiToken: 'tok_1',
        transactionId: 'txn_repeat',
        publicKeyHex,
        fetchImpl: fetchMock as unknown as typeof fetch,
        now,
      })

      expect(issued.licenseId).toBe('lic_existing')
      expect(issued.licenseKey).toBe(key)
      expect(issued.reused).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('GET')
    })

    it('refuses to mint when the lookup for an existing licence fails', async () => {
      const { publicKeyHex } = makeSignedKeygenKey({ holder: 'Acme' })
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
      await expect(
        issueKeygenLicense({
          accountId: 'acc_1', policyId: 'pol_1', apiToken: 'tok_1', transactionId: 'txn_x',
          publicKeyHex, fetchImpl: fetchMock as unknown as typeof fetch, now,
        }),
      ).rejects.toThrow(/existing licence/i)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})
