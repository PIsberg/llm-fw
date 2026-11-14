import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { noWorkingDirectoryLookup, systemTool } from '../../src/systemTool.js'

// The CLI runs Windows system tools (certutil, netsh, sc, net, reg, setx,
// netstat, schtasks, icacls), several of them from `setup` and `uninstall`,
// which usually run elevated, and two programs outside the system folder
// (ollama, lean-ctx). Windows looks for a bare name in the working directory
// before PATH, in cmd.exe (`execSync`) and in Node's own lookup
// (`execFileSync`, `spawn`), unless the calling process sets
// NoDefaultCurrentDirectoryInExePath. So a `certutil.bat` or a `reg.exe` in the
// folder a command was started from ran in place of the real one
// (GHSA-rhc4-5qxh-r96m). Every system tool is now named by its absolute path,
// and the CLI turns the lookup off for itself before anything else.

const ROOT = path.join(import.meta.dirname, '..', '..', 'src')
const TOOLS = ['certutil', 'icacls', 'net', 'netsh', 'netstat', 'reg', 'sc', 'schtasks', 'setx']
const WINDOWS = process.platform === 'win32'
const LOOKUP = 'NoDefaultCurrentDirectoryInExePath'

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? sources(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const WHOAMI = path.join(SYSTEM32, 'whoami.exe')

/** A command line run the way `execSync` runs it on Windows: by cmd.exe. */
function viaCmd(line: string, cwd: string): string {
  return execFileSync(path.join(SYSTEM32, 'cmd.exe'), ['/d', '/s', '/c', line], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** What a program printed to stdout, whether or not it exited 0. */
function printed(run: () => string): string {
  try {
    return run()
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? '')
  }
}

/**
 * Runs `work` with NoDefaultCurrentDirectoryInExePath removed from this
 * process, as in an ordinary terminal (Claude Code sets it in its own shells),
 * and puts it back afterwards. Test files run in their own process, so the
 * change reaches the lookup, which reads the caller's environment.
 */
function withLookupOn<T>(work: () => T): T {
  const saved = process.env[LOOKUP]
  delete process.env[LOOKUP]
  try {
    return work()
  } finally {
    if (saved === undefined) delete process.env[LOOKUP]
    else process.env[LOOKUP] = saved
  }
}

/** A fresh folder for planted files, removed after `work`. */
function inFolder<T>(work: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fw-systemtool-'))
  try {
    return work(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('systemTool', () => {
  it('names a Windows system tool by its path under SystemRoot, and leaves anything else alone', () => {
    expect(systemTool('certutil', 'win32', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\certutil.exe')
    expect(systemTool('netsh', 'win32', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\netsh.exe')
    // A missing or relative SystemRoot falls back to the default rather than to a lookup.
    expect(systemTool('reg', 'win32', {})).toBe('C:\\Windows\\System32\\reg.exe')
    expect(systemTool('reg', 'win32', { SystemRoot: 'Windows' })).toBe('C:\\Windows\\System32\\reg.exe')
    // Not a Windows system tool, or not on Windows: unchanged.
    expect(systemTool('ollama', 'win32', {})).toBe('ollama')
    expect(systemTool('netsh', 'linux', {})).toBe('netsh')
    expect(systemTool('launchctl', 'darwin', {})).toBe('launchctl')
  })

  it('is used by every call of a Windows system tool in the sources: none is run by bare name', () => {
    const bare: string[] = []
    // A tool named as the first argument of a child-process call.
    const call = /\b(?:execSync|execFileSync|spawnSync|spawn|exec|execFile)\(\s*(['"`])([^'"`\s]+)/g
    // A command line handed to a shell however it is built, such as
    // `execSync(win ? 'certutil ...' : 'security ...')`: a quoted tool name in
    // the three lines after `execSync(`.
    const shellCall = /\bexecSync\(/g
    const quotedTool = /(['"`])([a-z]+)\b/gi
    for (const file of sources(ROOT)) {
      const text = fs.readFileSync(file, 'utf8')
      const report = (index: number, tool: string) => {
        if (!TOOLS.includes(tool.toLowerCase())) return
        const at = `${path.relative(ROOT, file).replace(/\\/g, '/')}:${text.slice(0, index).split('\n').length} ${tool}`
        if (!bare.includes(at)) bare.push(at)
      }
      for (const m of text.matchAll(call)) report(m.index, m[2]!)
      for (const m of text.matchAll(shellCall)) {
        const window = text.slice(m.index, m.index + 400).split('\n').slice(0, 3).join('\n')
        for (const q of window.matchAll(quotedTool)) report(m.index, q[2]!)
      }
    }
    expect(bare).toEqual([])
  })

  it.runIf(WINDOWS)('runs the real tool from a folder that holds one of the same name', () => {
    inFolder(dir => {
      // Two impostors: a program (a copy of whoami.exe) and a batch file.
      fs.copyFileSync(WHOAMI, path.join(dir, 'certutil.exe'))
      fs.writeFileSync(path.join(dir, 'certutil.bat'), '@echo PLANTED\r\n')
      const me = execFileSync(WHOAMI, [], { encoding: 'utf8' }).trim()
      const out = withLookupOn(() =>
        printed(() => execFileSync(systemTool('certutil'), ['-?'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })),
      )
      expect(out).toMatch(/certutil/i)
      expect(out).not.toContain('PLANTED')
      expect(out.trim()).not.toBe(me)
    })
  })
})

describe('noWorkingDirectoryLookup', () => {
  it('sets NoDefaultCurrentDirectoryInExePath on Windows, and changes nothing elsewhere', () => {
    const win: NodeJS.ProcessEnv = {}
    noWorkingDirectoryLookup(win, 'win32')
    expect(win[LOOKUP]).toBe('1')
    for (const platform of ['linux', 'darwin'] as const) {
      const env: NodeJS.ProcessEnv = {}
      noWorkingDirectoryLookup(env, platform)
      expect(env).toEqual({})
    }
  })

  it('is the first thing the CLI does, before any subcommand can start a program', () => {
    const entry = fs.readFileSync(path.join(ROOT, 'cli', 'index.ts'), 'utf8')
    const statements = entry
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#!') && !line.startsWith('//') && !line.startsWith('import '))
    expect(statements[0]).toBe('noWorkingDirectoryLookup();')
  })

  // ollama and lean-ctx live outside System32, so no absolute path names them:
  // only turning the lookup off keeps a copy in the working directory from
  // running. Each case first shows that the copy does run with the lookup on,
  // so a pass is not a test that never saw a planted program.
  it.runIf(WINDOWS)("stops Node's own lookup from running a program planted in the working directory", () => {
    inFolder(dir => {
      fs.copyFileSync(WHOAMI, path.join(dir, 'reg.exe'))
      const me = execFileSync(WHOAMI, [], { encoding: 'utf8' }).trim()
      // A bare name on purpose: its lookup is what is under test.
      const bareName = 'reg'
      const reg = () => printed(() => execFileSync(bareName, [], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim()
      expect(withLookupOn(reg)).toBe(me)
      expect(
        withLookupOn(() => {
          noWorkingDirectoryLookup()
          return reg()
        }),
      ).not.toBe(me)
    })
  })

  it.runIf(WINDOWS)('stops cmd.exe from running a batch file planted in the working directory', () => {
    inFolder(dir => {
      fs.writeFileSync(path.join(dir, 'net.bat'), '@echo PLANTED\r\n')
      const net = () => printed(() => viaCmd('net session', dir))
      expect(withLookupOn(net)).toContain('PLANTED')
      expect(
        withLookupOn(() => {
          noWorkingDirectoryLookup()
          return net()
        }),
      ).not.toContain('PLANTED')
    })
  })
})
