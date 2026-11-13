import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { systemTool } from '../../src/systemTool.js'

// The CLI runs Windows system tools (certutil, netsh, sc, net, reg, setx,
// netstat, schtasks, icacls), several of them from `setup` and `uninstall`,
// which usually run elevated. Run by bare name through a shell, cmd.exe looks
// in the working directory before PATH (unless NoDefaultCurrentDirectoryInExePath
// is set), so a `certutil.bat` in the folder the command was started from ran
// in its place. Every call now names the tool by its absolute path.

const ROOT = path.join(import.meta.dirname, '..', '..', 'src')
const TOOLS = ['certutil', 'icacls', 'net', 'netsh', 'netstat', 'reg', 'sc', 'schtasks', 'setx']

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? sources(p) : e.name.endsWith('.ts') ? [p] : []
  })
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

  it.runIf(process.platform === 'win32')('runs the real tool from a folder that holds one of the same name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fw-systemtool-'))
    try {
      fs.writeFileSync(path.join(dir, 'certutil.bat'), '@echo PLANTED\r\n')
      const env = { ...process.env }
      delete env.NoDefaultCurrentDirectoryInExePath
      let out = ''
      try {
        out = execFileSync(systemTool('certutil'), ['-?'], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        out = String((err as { stdout?: string }).stdout ?? '')
      }
      expect(out).not.toContain('PLANTED')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
