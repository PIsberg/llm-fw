import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'

import { verifyKey } from '../../src/license/keygenKey.js'

// A real Ed25519 keypair, a real signature, a real Keygen-shaped key. Stubbing
// node:crypto here would test the stub: the whole point of this module is that
// the signature maths is right, so the test does the maths too.
function keypair(): { publicKeyHex: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // SPKI DER for Ed25519 is a fixed 12-byte header followed by the raw 32-byte
  // key — the same envelope verifyKey() rebuilds from the hex it is given.
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  return { publicKeyHex: der.subarray(12).toString('hex'), privateKey }
}

/** Mint a key exactly as Keygen's ED25519_SIGN scheme does. */
function mintKey(dataset: unknown, privateKey: KeyObject): string {
  const payload = Buffer.from(JSON.stringify(dataset), 'utf8').toString('base64url')
  const signingData = `key/${payload}`
  const signature = cryptoSign(null, Buffer.from(signingData, 'utf8'), privateKey)
  return `${signingData}.${signature.toString('base64url')}`
}

const OTHER_ACCOUNT_KEY = keypair().publicKeyHex

describe('verifyKey — signature', () => {
  it('accepts a key signed by the account that issued it', () => {
    const { publicKeyHex, privateKey } = keypair()
    const key = mintKey({ holder: 'Acme AB' }, privateKey)

    expect(verifyKey(key, publicKeyHex).verdict).toBe('valid')
  })

  it('rejects a key signed by a different account', () => {
    const { privateKey } = keypair()
    const key = mintKey({ holder: 'Acme AB' }, privateKey)

    // The failure that matters commercially: someone runs their own Keygen
    // account, mints themselves a key, and points it at this binary.
    expect(verifyKey(key, OTHER_ACCOUNT_KEY).verdict).toBe('forged')
  })

  it('rejects a key whose payload was edited after signing', () => {
    const { publicKeyHex, privateKey } = keypair()
    const key = mintKey({ holder: 'Acme AB', plan: 'solo' }, privateKey)
    const signature = key.slice(key.lastIndexOf('.'))
    const forgedPayload = Buffer.from(JSON.stringify({ holder: 'Acme AB', plan: 'enterprise' })).toString('base64url')

    expect(verifyKey(`key/${forgedPayload}${signature}`, publicKeyHex).verdict).toBe('forged')
  })

  it('rejects a signature with a flipped byte', () => {
    const { publicKeyHex, privateKey } = keypair()
    const key = mintKey({ holder: 'Acme AB' }, privateKey)
    const dot = key.lastIndexOf('.')
    const sig = Buffer.from(key.slice(dot + 1), 'base64url')
    sig[0] ^= 0xff

    expect(verifyKey(`${key.slice(0, dot)}.${sig.toString('base64url')}`, publicKeyHex).verdict).toBe('forged')
  })
})

describe('verifyKey — shapes that are not keys', () => {
  const { publicKeyHex, privateKey } = keypair()

  it.each([
    ['empty', ''],
    ['a plain non-cryptographic Keygen key', 'A1B2C3-D4E5F6-A7B8C9-D0E1F2'],
    ['the right prefix but no signature', 'key/eyJob2xkZXIiOiJBY21lIn0'],
    ['a signature that is not 64 bytes', 'key/eyJob2xkZXIiOiJBY21lIn0.c2hvcnQ'],
    ['a licence file, not a key', '-----BEGIN LICENSE FILE-----'],
  ])('reports %s as malformed rather than forged', (_label, input) => {
    // The distinction is load-bearing: `malformed` is surfaced to the user as
    // "we could not check this", `forged` as "this is fake". Calling a plain
    // Keygen key fake would accuse a paying customer.
    expect(verifyKey(input, publicKeyHex).verdict).toBe('malformed')
  })

  it('tolerates surrounding whitespace, since keys arrive via copy-paste', () => {
    const key = mintKey({ holder: 'Acme AB' }, privateKey)
    expect(verifyKey(`\n  ${key}  \n`, publicKeyHex).verdict).toBe('valid')
  })
})

describe('verifyKey — build not configured', () => {
  it.each([['empty', ''], ['a placeholder', 'TODO'], ['not hex', 'z'.repeat(64)], ['too short', 'ab'.repeat(16)]])(
    'reports %s account key as unconfigured, never forged',
    (_label, pubkey) => {
      const { privateKey } = keypair()
      const key = mintKey({ holder: 'Acme AB' }, privateKey)
      // Shipping a build with no verify key must not make every real key look
      // fake. `unconfigured` is what stops that from becoming a support queue.
      expect(verifyKey(key, pubkey).verdict).toBe('unconfigured')
    },
  )
})

describe('verifyKey — expiry', () => {
  const { publicKeyHex, privateKey } = keypair()
  const now = new Date('2026-08-10T12:00:00.000Z')

  it('accepts a key whose expiry is still ahead', () => {
    const key = mintKey({ holder: 'Acme AB', expiry: '2027-01-01T00:00:00.000Z' }, privateKey)
    expect(verifyKey(key, publicKeyHex, now).verdict).toBe('valid')
  })

  it('reports a passed expiry as expired, not forged', () => {
    const key = mintKey({ holder: 'Acme AB', expiry: '2026-01-01T00:00:00.000Z' }, privateKey)
    const result = verifyKey(key, publicKeyHex, now)
    expect(result.verdict).toBe('expired')
    expect(result.holder).toBe('Acme AB')
  })

  it('treats the expiry instant itself as expired', () => {
    const key = mintKey({ expiry: now.toISOString() }, privateKey)
    expect(verifyKey(key, publicKeyHex, now).verdict).toBe('expired')
  })

  it('treats a key with no expiry as perpetual', () => {
    const key = mintKey({ holder: 'Acme AB' }, privateKey)
    const result = verifyKey(key, publicKeyHex, now)
    expect(result.verdict).toBe('valid')
    expect(result.expiry).toBeUndefined()
  })

  it('ignores an unparseable expiry rather than locking the customer out', () => {
    const key = mintKey({ expiry: 'whenever' }, privateKey)
    expect(verifyKey(key, publicKeyHex, now).verdict).toBe('valid')
  })
})

describe('verifyKey — reading the embedded dataset', () => {
  const { publicKeyHex, privateKey } = keypair()

  it('reads holder, plan and expiry from flat fields', () => {
    const key = mintKey({ holder: 'Acme AB', plan: 'team', expiry: '2099-01-01T00:00:00.000Z' }, privateKey)
    expect(verifyKey(key, publicKeyHex)).toMatchObject({ verdict: 'valid', holder: 'Acme AB', plan: 'team' })
  })

  it("reads Keygen's nested license/policy/owner shape", () => {
    const key = mintKey(
      {
        license: { attributes: { name: 'Acme production', expiry: '2099-01-01T00:00:00.000Z' } },
        policy: { attributes: { name: 'Team annual' } },
        owner: { attributes: { email: 'ops@acme.example' } },
      },
      privateKey,
    )
    expect(verifyKey(key, publicKeyHex)).toMatchObject({
      verdict: 'valid',
      holder: 'Acme production',
      plan: 'Team annual',
    })
  })

  it('stays valid when the dataset carries none of the fields we look for', () => {
    // A policy that embeds a different dataset must not invalidate the licence.
    // The signature is the entitlement; the names are decoration.
    const key = mintKey({ some: 'other', shape: 1 }, privateKey)
    const result = verifyKey(key, publicKeyHex)
    expect(result.verdict).toBe('valid')
    expect(result.holder).toBeUndefined()
  })

  it('stays valid when the dataset is not JSON at all', () => {
    const payload = Buffer.from('acme@example.com', 'utf8').toString('base64url')
    const signingData = `key/${payload}`
    const signature = cryptoSign(null, Buffer.from(signingData, 'utf8'), privateKey)
    const result = verifyKey(`${signingData}.${signature.toString('base64url')}`, publicKeyHex)

    expect(result.verdict).toBe('valid')
    expect(result.dataset).toBe('acme@example.com')
  })
})
