import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { execSync, execFileSync } = vi.hoisted(() => ({ execSync: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', async (orig) => ({ ...(await orig<object>()), execSync, execFileSync }))

import { removeCaFromTrustStore, removePortRedirect } from '../../src/cli/uninstall.js'
import { portproxyRulesToAdd } from '../../src/cli/start.js'
import { writePriorEnv } from '../../src/cli/setup.js'
import { SuppressionStore } from '../../src/detection/suppressions.js'
import { serviceInstalled, systemdUnitPath, launchdPlistPath } from '../../src/cli/service.js'

beforeEach(() => { execSync.mockReset(); execFileSync.mockReset(); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())
const argsOf = (calls: unknown[][]) => calls.map(c => [String(c[0]).split(/[\\/]/).pop(), ...(c[1] as string[] ?? [])].join(' '))

// #921 part 1: any rule with the digits 443 in it (8443, 1443, 4430) read as
// llm-fw's own :443 redirect, so start never added it.
describe('the sinkhole port redirect on Windows (#921)', () => {
  const row = (listen: string, lport: number, cport: number) => `${listen}       ${lport}         127.0.0.1       ${cport}`
  it('adds the redirect when the only rules merely contain 443 in another port', () => {
    const v4 = ['Listen on ipv4:             Connect to ipv4:', row('0.0.0.0', 1443, 4430), row('127.0.0.1', 8443, 9000)].join('\r\n')
    expect(portproxyRulesToAdd(v4, '', 8443)).toEqual(['v4', 'v6'])
  })
  it('adds nothing when both of its rules are there', () => {
    expect(portproxyRulesToAdd(row('127.0.0.1', 443, 8443), row('::1', 443, 8443), 8443)).toEqual([])
  })

  it('uninstall removes the IPv6 rule even when the IPv4 one is already gone', () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('v4tov4') && args.includes('delete')) throw new Error('The system cannot find the file specified.')
    })
    removePortRedirect(8443, 'win32')
    expect(argsOf(execFileSync.mock.calls).some(a => a.includes('delete v6tov4'))).toBe(true)
  })
})

// #921 part 2: the CA left behind in the user store on Windows, all but one
// copy on macOS, and shell commands where an absolute path is wanted.
describe('removing the CA (#921)', () => {
  it('Windows: removes it from the user Root store as well as the machine one', () => {
    removeCaFromTrustStore('win32')
    const calls = argsOf(execFileSync.mock.calls)
    expect(calls.some(a => /-delstore -f Root/.test(a) && !a.includes('-user'))).toBe(true)
    expect(calls.some(a => a.includes('-user') && a.includes('-delstore'))).toBe(true)
  })

  it('macOS: removes every copy, with /usr/bin/security and no shell', () => {
    let copies = 3
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('/usr/bin/security')
      if (args[0] === 'find-certificate') { if (copies === 0) throw new Error('not found'); return '' }
      if (args[0] === 'delete-certificate') copies--
    })
    removeCaFromTrustStore('darwin')
    expect(copies).toBe(0)
    expect(execSync).not.toHaveBeenCalled()
  })
})

// #921 part 2: uninstall left install-service's auto-start entry, so the
// next login started the firewall again. It asks serviceInstalled first.
describe('finding the auto-start entry (#921)', () => {
  it.each([['linux', systemdUnitPath], ['darwin', launchdPlistPath]] as const)('%s: by its file', (os, where) => {
    const home = fs.mkdtempSync(join(tmpdir(), 'llm-fw-921-home-'))
    try {
      expect(serviceInstalled(os, home)).toBe(false)
      fs.mkdirSync(join(where(home), '..'), { recursive: true })
      fs.writeFileSync(where(home), '')
      expect(serviceInstalled(os, home)).toBe(true)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('win32: by asking Task Scheduler for the task', () => {
    expect(serviceInstalled('win32')).toBe(true)
    expect(argsOf(execFileSync.mock.calls)).toEqual(['schtasks.exe /Query /TN llm-fw'])
    execFileSync.mockImplementation(() => { throw new Error('ERROR: The system cannot find the file specified.') })
    expect(serviceInstalled('win32')).toBe(false)
  })
})

// #921 part 3: state files written in place with the default mode.
describe('state files are written privately and whole (#921)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-921-')); process.env.LLM_FW_DIR = dir })
  afterEach(() => { delete process.env.LLM_FW_DIR; fs.rmSync(dir, { recursive: true, force: true }) })
  const leftovers = () => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))

  it.runIf(process.platform !== 'win32')('env-before.json and suppressions.json are 0600', () => {
    writePriorEnv(dir, { HTTPS_PROXY: 'http://user:secret@proxy.example:3128' })
    expect(fs.statSync(join(dir, 'env-before.json')).mode & 0o777).toBe(0o600)
    const store = new SuppressionStore()
    store.load()
    store.add('a text marked as a false positive', 'prompt')
    expect(fs.statSync(SuppressionStore.filePath()).mode & 0o777).toBe(0o600)
  })

  it('writes through a temporary file it renames into place', () => {
    const rename = vi.spyOn(fs, 'renameSync')
    writePriorEnv(dir, { HTTPS_PROXY: 'http://proxy.example:3128' })
    expect(rename).toHaveBeenCalledWith(expect.stringMatching(/env-before\.json\..*\.tmp$/), join(dir, 'env-before.json'))
    expect(JSON.parse(fs.readFileSync(join(dir, 'env-before.json'), 'utf8'))).toEqual({ HTTPS_PROXY: 'http://proxy.example:3128' })
    expect(leftovers()).toEqual([])
  })
})
