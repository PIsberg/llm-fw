import { describe, it, expect, vi } from 'vitest'
import { isNewer, checkForUpdate, shouldCheckForUpdates, startupBanner, UPDATE_COMMAND } from '../../src/cli/updateCheck.js'

// #597: `llm-fw start` says which version runs, and whether a newer one is
// published, with the command to update. The check asks the npm registry and
// must never delay or break startup.
describe('comparing versions', () => {
  it('orders by major, minor and patch numerically', () => {
    expect(isNewer('0.9.3', '0.9.4')).toBe(true)
    expect(isNewer('0.9.3', '0.10.0')).toBe(true)
    expect(isNewer('0.9.3', '1.0.0')).toBe(true)
    expect(isNewer('0.9.3', '0.9.3')).toBe(false)
    expect(isNewer('0.10.0', '0.9.9')).toBe(false)
  })

  it('treats a prerelease as older than its release, and ignores unparseable versions', () => {
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(false)
    expect(isNewer('0.9.3', 'latest')).toBe(false)
    expect(isNewer('dev', '0.9.3')).toBe(false)
  })
})

describe('checking the registry', () => {
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))

  it('says when a newer version is published, with the command to update', async () => {
    const fetchImpl = ok({ name: 'llm-fw', version: '0.9.4' })
    const msg = await checkForUpdate('0.9.3', fetchImpl as unknown as typeof fetch)
    expect(msg).toContain('0.9.4')
    expect(msg).toContain('0.9.3')
    expect(msg).toContain(UPDATE_COMMAND)
    expect(fetchImpl).toHaveBeenCalledWith('https://registry.npmjs.org/llm-fw/latest', expect.objectContaining({ signal: expect.anything() }))
  })

  it('says nothing when this is the latest, or newer', async () => {
    expect(await checkForUpdate('0.9.3', ok({ version: '0.9.3' }) as unknown as typeof fetch)).toBeNull()
    expect(await checkForUpdate('0.9.4', ok({ version: '0.9.3' }) as unknown as typeof fetch)).toBeNull()
  })

  it('says nothing on any failure: offline, an error status, a body that is not the expected JSON', async () => {
    expect(await checkForUpdate('0.9.3', vi.fn(async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch)).toBeNull()
    expect(await checkForUpdate('0.9.3', vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch)).toBeNull()
    expect(await checkForUpdate('0.9.3', vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch)).toBeNull()
    expect(await checkForUpdate('0.9.3', ok({ version: 42 }) as unknown as typeof fetch)).toBeNull()
  })

  it('gives up after the timeout instead of holding startup', async () => {
    const hang = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))))
    const t0 = Date.now()
    expect(await checkForUpdate('0.9.3', hang as unknown as typeof fetch, 50)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('when to check', () => {
  it('checks by default, and not when switched off or under CI', () => {
    expect(shouldCheckForUpdates({ updateCheck: true }, {})).toBe(true)
    expect(shouldCheckForUpdates({}, {})).toBe(true)
    expect(shouldCheckForUpdates({ updateCheck: false }, {})).toBe(false)
    expect(shouldCheckForUpdates({ updateCheck: true }, { CI: 'true' })).toBe(false)
  })
})

describe('the startup line', () => {
  it('names the version and the ruleset', () => {
    expect(startupBanner('0.9.3', '2026.10.118')).toBe('llm-fw 0.9.3 (ruleset 2026.10.118)')
  })
})
