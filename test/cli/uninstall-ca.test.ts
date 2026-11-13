import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Every command uninstall would run against the real trust store is mocked.
const { execSync, execFileSync } = vi.hoisted(() => ({ execSync: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execSync, execFileSync }))

import { removeCaFromTrustStore } from '../../src/cli/uninstall.js'
import { systemTool } from '../../src/systemTool.js'

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
    execFileSync.mockReset()
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const output = () => [...log.mock.calls, ...warn.mock.calls].map(c => String(c[0])).join('\n')
  const deleteCalls = () => execFileSync.mock.calls.filter(c => (c[1] as string[]).includes('-delstore'))

  it('reports nothing to remove, and warns about nothing, when the CA was never installed', () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('-store')) throw new Error('CRYPT_E_NOT_FOUND')
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

  it('runs certutil by its absolute path and without a shell, for the lookup and the delete', () => {
    removeCaFromTrustStore('win32')
    expect(execSync).not.toHaveBeenCalled()
    expect(execFileSync.mock.calls.map(c => c[0])).toEqual([systemTool('certutil', 'win32'), systemTool('certutil', 'win32')])
    expect(execFileSync.mock.calls.map(c => c[1])).toEqual([['-store', 'Root', 'llm-fw Local CA'], ['-delstore', '-f', 'Root', 'llm-fw Local CA']])
  })

  it('still warns when an installed CA cannot be removed', () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('-delstore')) throw new Error('access denied')
    })
    removeCaFromTrustStore('win32')
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('certutil -delstore -f Root "llm-fw Local CA"')
  })
})
