import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted so the (also-hoisted) vi.mock factories can close over them. Every
// OS-touching call service.ts makes — fs writes/reads/deletes and
// execFileSync — is mocked here. If a test in this file ever caused a real
// schtasks/launchctl/systemctl invocation or a real write under ~/Library or
// ~/.config, these mocks not being wired up would be the bug.
const { mkdirSync, writeFileSync, existsSync, unlinkSync, execFileSync } = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  unlinkSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  default: { mkdirSync, writeFileSync, existsSync, unlinkSync },
}))
vi.mock('node:child_process', () => ({ execFileSync }))

import {
  resolveInvocation,
  buildInstallPlan,
  buildUninstallPlan,
  buildLaunchdPlist,
  buildSystemdUnit,
  launchdPlistPath,
  systemdUnitPath,
  installService,
  uninstallService,
  TASK_NAME,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  type Invocation,
} from '../../src/cli/service.js'

const HOME_WIN = 'C:\\Users\\tester'
const HOME_POSIX = '/home/tester'

function inv(): Invocation {
  return { command: 'C:\\node\\node.exe', args: ['C:\\llm-fw\\dist\\cli\\index.js', 'start'] }
}

function invPosix(): Invocation {
  return { command: '/usr/bin/node', args: ['/usr/lib/llm-fw/dist/cli/index.js', 'start'] }
}

beforeEach(() => {
  mkdirSync.mockClear()
  writeFileSync.mockClear()
  existsSync.mockClear().mockReturnValue(true)
  unlinkSync.mockClear()
  execFileSync.mockClear()
})

describe('resolveInvocation', () => {
  it('pairs the node binary with the running script path plus "start"', () => {
    const result = resolveInvocation('/usr/bin/node', '/opt/llm-fw/dist/cli/index.js')
    expect(result).toEqual({ command: '/usr/bin/node', args: ['/opt/llm-fw/dist/cli/index.js', 'start'] })
  })

  it('defaults to the real process.execPath/argv[1] when not given', () => {
    const result = resolveInvocation()
    expect(result.command).toBe(process.execPath)
    expect(result.args[1]).toBe('start')
  })
})

describe('buildInstallPlan — Windows (schtasks)', () => {
  it('generates a schtasks /Create ONLOGON task with no files to write', () => {
    const plan = buildInstallPlan('win32', inv(), HOME_WIN)
    expect(plan.files).toEqual([])
    expect(plan.commands).toHaveLength(1)
    const cmd = plan.commands[0]
    expect(cmd.cmd).toBe('schtasks')
    expect(cmd.args).toEqual(
      expect.arrayContaining(['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR'])
    )
    const trValue = cmd.args[cmd.args.indexOf('/TR') + 1]
    expect(trValue).toBe('"C:\\node\\node.exe" "C:\\llm-fw\\dist\\cli\\index.js" "start"')
  })
})

describe('buildInstallPlan — macOS (launchd)', () => {
  it('writes a LaunchAgent plist under ~/Library/LaunchAgents and loads it', () => {
    const plan = buildInstallPlan('darwin', invPosix(), '/Users/tester')
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0].path).toBe(launchdPlistPath('/Users/tester'))
    expect(plan.files[0].path).toContain('Library/LaunchAgents')
    expect(plan.files[0].path).toContain(`${LAUNCHD_LABEL}.plist`)
    expect(plan.files[0].contents).toContain('<key>Label</key>')
    expect(plan.files[0].contents).toContain(`<string>${LAUNCHD_LABEL}</string>`)
    expect(plan.files[0].contents).toContain('<string>/usr/bin/node</string>')
    expect(plan.files[0].contents).toContain('<string>/usr/lib/llm-fw/dist/cli/index.js</string>')
    expect(plan.files[0].contents).toContain('<string>start</string>')
    expect(plan.files[0].contents).toContain('<key>RunAtLoad</key>')
    expect(plan.files[0].contents).toContain('<true/>')

    expect(plan.commands).toEqual([{ cmd: 'launchctl', args: ['load', plan.files[0].path] }])
  })

  it('XML-escapes path components that could break the plist', () => {
    const weird: Invocation = { command: '/usr/bin/node', args: ['/path/with & <special> "chars"', 'start'] }
    const plist = buildLaunchdPlist(weird, '/Users/tester')
    expect(plist).toContain('&amp;')
    expect(plist).toContain('&lt;special&gt;')
    expect(plist).toContain('&quot;chars&quot;')
    expect(plist).not.toContain('with & <special>')
  })
})

describe('buildInstallPlan — Linux (systemd --user)', () => {
  it('writes a user unit under ~/.config/systemd/user and enables it', () => {
    const plan = buildInstallPlan('linux', invPosix(), HOME_POSIX)
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0].path).toBe(systemdUnitPath(HOME_POSIX))
    expect(plan.files[0].path).toContain('.config/systemd/user')
    expect(plan.files[0].path).toContain(SYSTEMD_UNIT)
    expect(plan.files[0].contents).toContain('[Unit]')
    expect(plan.files[0].contents).toContain('[Service]')
    expect(plan.files[0].contents).toContain('ExecStart="/usr/bin/node" "/usr/lib/llm-fw/dist/cli/index.js" "start"')
    expect(plan.files[0].contents).toContain('[Install]')
    expect(plan.files[0].contents).toContain('WantedBy=default.target')

    expect(plan.commands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--now', SYSTEMD_UNIT] },
    ])
  })
})

describe('buildUninstallPlan', () => {
  it('Windows: deletes the schtasks entry, no files', () => {
    const plan = buildUninstallPlan('win32', HOME_WIN)
    expect(plan.commands).toEqual([{ cmd: 'schtasks', args: ['/Delete', '/TN', TASK_NAME, '/F'] }])
    expect(plan.filesToDelete).toEqual([])
  })

  it('macOS: unloads and deletes the plist', () => {
    const plan = buildUninstallPlan('darwin', '/Users/tester')
    const plistPath = launchdPlistPath('/Users/tester')
    expect(plan.commands).toEqual([{ cmd: 'launchctl', args: ['unload', plistPath] }])
    expect(plan.filesToDelete).toEqual([plistPath])
  })

  it('Linux: disables and deletes the unit', () => {
    const plan = buildUninstallPlan('linux', HOME_POSIX)
    const unitPath = systemdUnitPath(HOME_POSIX)
    expect(plan.commands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', SYSTEMD_UNIT] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
    ])
    expect(plan.filesToDelete).toEqual([unitPath])
  })
})

describe('installService (executor — all side effects mocked)', () => {
  it('on darwin: writes the plist and invokes launchctl load, and only those mocks', async () => {
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      await installService([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
    }

    expect(mkdirSync).toHaveBeenCalledTimes(1)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
    expect(writeFileSync.mock.calls[0][0]).toContain('LaunchAgents')
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(execFileSync.mock.calls[0][0]).toBe('launchctl')
    expect(execFileSync.mock.calls[0][1]).toEqual(['load', expect.stringContaining('LaunchAgents')])
    expect(process.exitCode).not.toBe(1)
  })

  it('on linux: writes the unit and runs daemon-reload + enable --now', async () => {
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      await installService([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
    }

    expect(writeFileSync).toHaveBeenCalledTimes(1)
    expect(execFileSync).toHaveBeenCalledTimes(2)
    expect(execFileSync.mock.calls[0]).toEqual(['systemctl', ['--user', 'daemon-reload'], expect.anything()])
    expect(execFileSync.mock.calls[1]).toEqual(['systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], expect.anything()])
  })

  it('on win32: writes no files, calls schtasks /Create once', async () => {
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await installService([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
    }

    expect(writeFileSync).not.toHaveBeenCalled()
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(execFileSync.mock.calls[0][0]).toBe('schtasks')
    expect(execFileSync.mock.calls[0][1]).toContain('/Create')
  })

  it('refuses politely on an unsupported platform without touching fs/child_process', async () => {
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'freebsd' })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      process.exitCode = undefined
      await installService([])
      expect(process.exitCode).toBe(1)
      expect(errSpy.mock.calls.some(c => c[0].includes('unsupported platform'))).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
      process.exitCode = undefined
      errSpy.mockRestore()
    }
    expect(execFileSync).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('reports a failure and sets a nonzero exit code when the OS command fails (no throw)', async () => {
    execFileSync.mockImplementationOnce(() => { throw new Error('Access is denied.') })
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      process.exitCode = undefined
      expect(() => installService([])).not.toThrow()
      expect(process.exitCode).toBe(1)
      expect(errSpy.mock.calls.some(c => String(c[0]).includes('Access is denied.'))).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
      process.exitCode = undefined
      errSpy.mockRestore()
    }
  })
})

describe('uninstallService (executor — all side effects mocked)', () => {
  it('on darwin: unloads then deletes the plist file', async () => {
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      await uninstallService([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
    }

    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(execFileSync.mock.calls[0][0]).toBe('launchctl')
    expect(execFileSync.mock.calls[0][1][0]).toBe('unload')
    expect(unlinkSync).toHaveBeenCalledTimes(1)
    expect(unlinkSync.mock.calls[0][0]).toContain('LaunchAgents')
  })

  it('on linux: disables the unit, reloads the daemon, then deletes the unit file', async () => {
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      await uninstallService([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
    }

    expect(execFileSync).toHaveBeenCalledTimes(2)
    expect(execFileSync.mock.calls[0][1]).toEqual(['--user', 'disable', '--now', SYSTEMD_UNIT])
    expect(execFileSync.mock.calls[1][1]).toEqual(['--user', 'daemon-reload'])
    expect(unlinkSync).toHaveBeenCalledTimes(1)
  })

  it('on win32: only deletes the schtasks entry (no files to remove)', async () => {
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await uninstallService([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
    }

    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(execFileSync.mock.calls[0]).toEqual(['schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], expect.anything()])
    expect(unlinkSync).not.toHaveBeenCalled()
  })

  it('is best-effort: a failed command does not stop the file cleanup, and warns instead of throwing', async () => {
    execFileSync.mockImplementationOnce(() => { throw new Error('task not found') })
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => uninstallService([])).not.toThrow()
      expect(unlinkSync).toHaveBeenCalledTimes(1) // cleanup still runs
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
      warnSpy.mockRestore()
    }
  })

  it('skips deleting files that do not exist (never installed) without erroring', async () => {
    existsSync.mockReturnValue(false)
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      await uninstallService([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform })
    }
    expect(unlinkSync).not.toHaveBeenCalled()
  })
})

describe('buildSystemdUnit', () => {
  it('quotes each argv element independently so paths with spaces stay one token', () => {
    const withSpace: Invocation = { command: '/usr/bin/node', args: ['/home/me/my app/index.js', 'start'] }
    const unit = buildSystemdUnit(withSpace)
    expect(unit).toContain('ExecStart="/usr/bin/node" "/home/me/my app/index.js" "start"')
  })
})
