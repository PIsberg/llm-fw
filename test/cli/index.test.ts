import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The dispatcher's exit status, observed from a real process. `llm-fw --help`
 * used to fall through to the unknown-command branch and exit 1, so a script
 * guarding on `llm-fw --help >/dev/null` (or a package manager probing the
 * binary) read a working install as a broken one.
 */
const cli = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url))

// The child gets 30 s, and so must the test around it: each spawn compiles the
// CLI through tsx, ~0.1 s alone but 5.4-8.9 s in the parallel full suite,
// where vitest's 5 s default failed the test before the child could finish.
const SPAWN_TIMEOUT_MS = 30_000

function runCli(...args: (string | Record<string, string>)[]) {
  const env = args.find((a): a is Record<string, string> => typeof a !== 'string')
  const argv = args.filter((a): a is string => typeof a === 'string')
  return spawnSync(process.execPath, ['--import', 'tsx/esm', cli, ...argv], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, ...env },
  })
}

describe('llm-fw dispatcher exit status', { timeout: SPAWN_TIMEOUT_MS }, () => {
  for (const flag of ['--help', '-h', 'help']) {
    it(`${flag} prints usage and exits 0`, () => {
      const r = runCli(flag)
      expect(r.stdout).toContain('Usage: llm-fw <command>')
      expect(r.status).toBe(0)
    })
  }

  it('no command prints usage and exits 0', () => {
    const r = runCli()
    expect(r.stdout).toContain('Usage: llm-fw <command>')
    expect(r.status).toBe(0)
  })

  // `llm-fw --version` used to fall into the unknown-command branch: the whole
  // usage text and exit 1, so "which llm-fw do I have?" had no answer short of
  // `npm ls -g`, and a script probing the version read a broken install.
  for (const flag of ['--version', '-v', 'version']) {
    it(`${flag} prints the package version and exits 0`, () => {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
      const r = runCli(flag)
      expect(r.stdout.trim()).toBe(`llm-fw ${pkg.version}`)
      expect(r.status).toBe(0)
    })
  }

  it('an unknown command prints usage and exits 1', () => {
    const r = runCli('bogus')
    expect(r.stdout).toContain('Usage: llm-fw <command>')
    expect(r.status).toBe(1)
  })

  // `llm-fw start --obeserve` used to start the firewall in enforce mode: the
  // misspelt flag was ignored, so it refused traffic the operator had asked
  // only to observe. It must refuse to start instead. The child gets a scratch
  // LLM_FW_DIR and spare ports so that, should the check regress, it cannot
  // replace the developer's running instance.
  it('an unknown flag to start refuses to start, names the flag and exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-fw-options-'))
    try {
      const r = runCli('start', '--obeserve', {
        LLM_FW_DIR: dir, LLM_FW_PROXY_PORT: '28080', LLM_FW_DASHBOARD_PORT: '27731',
      })
      expect(r.stderr).toContain('"--obeserve"')
      expect(r.stderr).toContain('--observe')
      expect(r.stdout).not.toContain('Usage: llm-fw <command>')
      expect(r.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unknown flag to doctor is refused before it runs', () => {
    const r = runCli('doctor', '--jsn')
    expect(r.stderr).toContain('"--jsn"')
    expect(r.stderr).toContain('--json')
    expect(r.status).toBe(1)
  })

  it('--help after a subcommand prints usage and exits 0 instead of running it', () => {
    const r = runCli('status', '--help')
    expect(r.stdout).toContain('Usage: llm-fw <command>')
    expect(r.status).toBe(0)
  })
})
