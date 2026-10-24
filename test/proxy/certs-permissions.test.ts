import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted so the (also-hoisted) vi.mock factories can close over them.
const { chmodSync, execFileSync, platformMock } = vi.hoisted(() => ({
  chmodSync: vi.fn(),
  execFileSync: vi.fn(),
  platformMock: vi.fn(),
}))

// certs.ts uses a default fs import and named os/child_process imports.
vi.mock('node:fs', () => ({
  default: {
    chmodSync,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  },
}))
vi.mock('node:child_process', () => ({ execFileSync }))
vi.mock('node:os', () => ({ homedir: () => '/tmp/home', platform: platformMock }))

import { restrictDirPermissions } from '../../src/proxy/certs.js'

describe('restrictDirPermissions', () => {
  beforeEach(() => {
    chmodSync.mockClear()
    execFileSync.mockClear()
  })

  it('restricts the directory with chmod 0700 on POSIX', () => {
    platformMock.mockReturnValue('linux')
    restrictDirPermissions('/home/u/.llm-fw')
    expect(chmodSync).toHaveBeenCalledWith('/home/u/.llm-fw', 0o700)
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('restricts the directory with icacls on Windows (CA key cannot inherit open ACLs)', () => {
    platformMock.mockReturnValue('win32')
    process.env.USERNAME = 'tester'
    const savedDomain = process.env.USERDOMAIN
    delete process.env.USERDOMAIN
    const dir = 'C:\\Users\\tester\\.llm-fw'

    restrictDirPermissions(dir)

    // chmod is a no-op on Windows; ACLs must be set via icacls instead.
    expect(chmodSync).not.toHaveBeenCalled()
    expect(execFileSync).toHaveBeenCalledTimes(1)

    const [cmd, args] = execFileSync.mock.calls[0]
    expect(cmd).toBe('icacls')
    expect(args[0]).toBe(dir)
    // Inheritance removed and access granted to the current user only.
    expect(args).toContain('/inheritance:r')
    expect(args).toContain('tester:(OI)(CI)F')
    if (savedDomain !== undefined) process.env.USERDOMAIN = savedDomain
  })

  // icacls resolves a bare name against local accounts before the domain, so
  // a domain user CORP\alice on a machine with a local "alice" granted the
  // local account the CA key and locked themselves out of it.
  it('names the account with its domain when Windows reports one', () => {
    platformMock.mockReturnValue('win32')
    process.env.USERNAME = 'alice'
    const savedDomain = process.env.USERDOMAIN
    process.env.USERDOMAIN = 'CORP'

    restrictDirPermissions('C:\\Users\\alice\\.llm-fw')

    const [, args] = execFileSync.mock.calls[0]
    expect(args).toContain('CORP\\alice:(OI)(CI)F')
    expect(args).not.toContain('alice:(OI)(CI)F')
    if (savedDomain === undefined) delete process.env.USERDOMAIN
    else process.env.USERDOMAIN = savedDomain
  })

  it('skips ACL changes on Windows when the owning user is unknown', () => {
    platformMock.mockReturnValue('win32')
    const saved = process.env.USERNAME
    delete process.env.USERNAME

    restrictDirPermissions('C:\\x\\.llm-fw')

    expect(execFileSync).not.toHaveBeenCalled()
    if (saved !== undefined) process.env.USERNAME = saved
  })
})

describe('the CA key file', () => {
  // On POSIX the key sat at the umask default (usually 0644) inside the 0700
  // directory, so it was private only for as long as the directory stayed so.
  it('is written owner-only, independent of the directory', async () => {
    platformMock.mockReturnValue('linux')
    const fs = (await import('node:fs')).default as unknown as { writeFileSync: ReturnType<typeof vi.fn> }
    fs.writeFileSync.mockClear()
    const { CertFactory } = await import('../../src/proxy/certs.js')

    new CertFactory('http://127.0.0.1:7731/crl').generateCA()

    const keyWrite = fs.writeFileSync.mock.calls.find(c => String(c[0]).endsWith('ca.key'))
    expect(keyWrite).toBeDefined()
    expect(keyWrite?.[2]).toMatchObject({ mode: 0o600 })
  })
})
