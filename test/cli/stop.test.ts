import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../src/cli/stop.js'

/**
 * `start` removes its pid file from an exit handler, but on Windows SIGTERM is
 * TerminateProcess: the handler never runs, so every `llm-fw stop` left a
 * pid file naming a dead process behind. `stop` has to clean up after the
 * process it killed rather than rely on the process doing it.
 */
describe('llm-fw stop', () => {
  let dir: string
  let prevDir: string | undefined
  let child: ChildProcess | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llm-fw-stop-'))
    prevDir = process.env.LLM_FW_DIR
    process.env.LLM_FW_DIR = dir
  })

  afterEach(() => {
    try { child?.kill('SIGKILL') } catch { /* already dead */ }
    if (prevDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('removes the pid file of a process that cannot clean up after itself', async () => {
    // Stands in for `llm-fw start` killed by TerminateProcess: it holds a pid
    // file it will never remove.
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const pidFile = join(dir, 'llm-fw.pid')
    writeFileSync(pidFile, String(child.pid))

    await run()

    expect(existsSync(pidFile)).toBe(false)
    expect(() => process.kill(child!.pid!, 0)).toThrow()
  })

  it('removes a stale pid file whose process is already gone', async () => {
    const pidFile = join(dir, 'llm-fw.pid')
    // Far above any real pid limit, so the liveness probe fails.
    writeFileSync(pidFile, '2147483646')

    await run()

    expect(existsSync(pidFile)).toBe(false)
  })
})
