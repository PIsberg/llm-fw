import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Every command uninstall would run against the real trust store is mocked.
const { execSync } = vi.hoisted(() => ({ execSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execSync, execFileSync: vi.fn() }))

import { removeCaFromTrustStore } from '../../src/cli/uninstall.js'

/**
 * A non-elevated Windows setup cannot install the CA, so the matching
 * uninstall found nothing to remove, failed the (elevated-only) delete, and
 * told the user it "could not remove the CA" and to re-run elevated. Found on
 * a live install. Uninstall has to look before it reports a failure.
 */
describe('removeCaFromTrustStore', () => {
  let log: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    execSync.mockReset()
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const output = () => [...log.mock.calls, ...warn.mock.calls].map(c => String(c[0])).join('\n')
  const deleteCalls = () => execSync.mock.calls.filter(c => String(c[0]).includes('-delstore'))

  it('reports nothing to remove, and warns about nothing, when the CA was never installed', () => {
    execSync.mockImplementation((cmd: string) => {
      if (cmd.includes('-store Root')) throw new Error('CRYPT_E_NOT_FOUND')
    })
    removeCaFromTrustStore('win32')
    expect(deleteCalls()).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    expect(output()).toMatch(/not in the OS trust store/)
  })

  it('removes an installed CA', () => {
    removeCaFromTrustStore('win32')
    expect(deleteCalls()).toHaveLength(1)
    expect(output()).toContain('CA removed from OS trust store')
  })

  it('still warns when an installed CA cannot be removed', () => {
    execSync.mockImplementation((cmd: string) => {
      if (cmd.includes('-delstore')) throw new Error('access denied')
    })
    removeCaFromTrustStore('win32')
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('certutil -delstore -f Root "llm-fw Local CA"')
  })
})
