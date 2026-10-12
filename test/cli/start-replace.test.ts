import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killPreviousInstance } from '../../src/cli/stop.js'

/**
 * A second `llm-fw start` kills the running one on purpose (it inherits the
 * sinkhole's hosts entries and port redirect without admin rights). It did so
 * without a word: found live on 2026-10-12, the first terminal's process just
 * exited 1 and the second printed nothing about it, so a manual start
 * silently replaced, for example, the instance install-service launched at
 * login, flags and all. start reports the PID this returns.
 */
describe('killPreviousInstance', () => {
  let dir: string
  let child: ChildProcess | undefined

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'llm-fw-replace-')) })
  afterEach(() => {
    try { child?.kill('SIGKILL') } catch { /* already dead */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the PID of the running instance it replaced', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const exited = new Promise(resolve => child!.on('exit', resolve))
    const pidFile = join(dir, 'llm-fw.pid')
    writeFileSync(pidFile, String(child.pid))

    expect(killPreviousInstance(pidFile)).toBe(child.pid)
    await exited
    expect(existsSync(pidFile)).toBe(false)
  })

  it('returns null for a stale pid file, and removes it', () => {
    const pidFile = join(dir, 'llm-fw.pid')
    writeFileSync(pidFile, '999999')
    expect(killPreviousInstance(pidFile)).toBeNull()
    expect(existsSync(pidFile)).toBe(false)
  })

  it('returns null when nothing is running', () => {
    expect(killPreviousInstance(join(dir, 'llm-fw.pid'))).toBeNull()
  })
})
