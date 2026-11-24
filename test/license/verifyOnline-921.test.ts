import { describe, it, expect, vi, afterEach } from 'vitest'
import { verifyOnline } from '../../src/license/verifyOnline.js'

// #921 part 4: a Keygen outage or rate limit answered with a JSON error body
// read as an invalid key, where an unreachable Keygen reads as unknown.
afterEach(() => vi.unstubAllGlobals())
const reply = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/vnd.api+json' } })))

describe('verifyOnline on a server error (#921)', () => {
  it.each([500, 502, 503, 429])('answers unknown, not invalid, on %i', async (status) => {
    reply(status, { errors: [{ detail: 'Service unavailable' }] })
    expect((await verifyOnline('KEY-123')).valid).toBeNull()
  })

  it('still answers invalid on a client error', async () => {
    reply(422, { errors: [{ detail: 'key not found' }] })
    expect((await verifyOnline('KEY-123')).valid).toBe(false)
  })
})
