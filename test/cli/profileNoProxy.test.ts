import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addProfileEnvVars, DEFAULT_NO_PROXY } from '../../src/cli/setup.js'
import { stripProfileEnvVars } from '../../src/cli/uninstall.js'

// #683: the effective NO_PROXY is what a shell reports after sourcing the profile,
// not the text of the file. A shell keeps the last export, so this is the value
// every tool sees.
function effectiveNoProxy(profile: string): string {
  // A clean environment: an inherited NO_PROXY would be appended again by the
  // profile's own `${NO_PROXY:+...}` and read as a duplicate.
  const r = spawnSync('sh', ['-c', `. "$1"; printf %s "$NO_PROXY"`, 'sh', profile], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })
  if (r.status !== 0) throw new Error(`sh failed: ${r.stderr}`)
  return r.stdout
}

function profileFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'llmfw-profile-'))
  const file = join(dir, '.profile')
  writeFileSync(file, content, 'utf8')
  return file
}

describe.skipIf(process.platform === 'win32')('POSIX NO_PROXY reaches the shell (#683)', () => {
  it('keeps the user\'s internal hosts in the effective NO_PROXY after setup', () => {
    const user = 'export NO_PROXY=intranet.corp,10.0.0.0/8\n'
    const out = addProfileEnvVars(user, 'http://127.0.0.1:8080')
    const value = effectiveNoProxy(profileFile(out))
    const entries = value.split(',')
    expect(entries).toContain('intranet.corp')
    expect(entries).toContain('10.0.0.0/8')
    expect(entries).toContain('localhost')
    expect(entries).toContain('127.0.0.1')
  })

  it('still excludes llm-fw\'s loopback entries when the user has no NO_PROXY', () => {
    const out = addProfileEnvVars('', 'http://127.0.0.1:8080')
    expect(effectiveNoProxy(profileFile(out))).toBe(DEFAULT_NO_PROXY)
  })

  it('does not duplicate entries on a second setup run', () => {
    const once = addProfileEnvVars('export NO_PROXY=intranet.corp\n', 'http://127.0.0.1:8080')
    const twice = addProfileEnvVars(once, 'http://127.0.0.1:8080')
    const entries = effectiveNoProxy(profileFile(twice)).split(',')
    expect(entries.filter(e => e === 'intranet.corp')).toHaveLength(1)
    expect(entries.filter(e => e === '127.0.0.1')).toHaveLength(1)
  })

  it('uninstall leaves the user\'s own NO_PROXY line in place', () => {
    const user = 'export NO_PROXY=intranet.corp\n'
    const installed = addProfileEnvVars(user, 'http://127.0.0.1:8080')
    const stripped = stripProfileEnvVars(installed)
    expect(stripped).toContain('export NO_PROXY=intranet.corp')
    expect(stripped).not.toContain('# llm-fw env')
  })
})
