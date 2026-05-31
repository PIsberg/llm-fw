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
