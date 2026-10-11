import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/cli/stop.js'
import { watchForStopRequest } from '../../src/cli/stopRequest.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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

    // No stop watcher in this child, so stop falls back to a signal once the
    // stop request goes unanswered.
    await run({ requestWaitMs: 300 })

    expect(existsSync(pidFile)).toBe(false)
    expect(() => process.kill(child!.pid!, 0)).toThrow()
  })

  it('lets the running process clean up and exit 0 instead of killing it (#310)', async () => {
    // On Windows a signal is TerminateProcess: start's SIGTERM handler, which
    // restores the hosts file and removes the :443 portproxy, never ran, and
    // the process exited 1. A stop request the process polls for works the
    // same on every platform.
    child = spawn(process.execPath, ['--import', 'tsx/esm', join(REPO, 'test', 'cli', 'fixtures', 'stop-watcher-child.ts')], {
      cwd: REPO,
      env: { ...process.env, LLM_FW_DIR: dir },
      stdio: 'ignore',
    })
    const exited = new Promise<number | null>(resolve => child!.on('exit', code => resolve(code)))
    const readyBy = Date.now() + 15_000
    while (!existsSync(join(dir, 'ready')) && Date.now() < readyBy) await new Promise(r => setTimeout(r, 50))

    await run()

    expect(await exited).toBe(0)
    expect(existsSync(join(dir, 'cleaned-up'))).toBe(true)
    expect(existsSync(join(dir, 'llm-fw.pid'))).toBe(false)
  }, 30_000)

  it('ignores a stop request left over from before the process started', async () => {
    writeFileSync(join(dir, 'llm-fw.stop'), String(process.pid))
    let stopped = false

    const unwatch = watchForStopRequest(dir, process.pid, () => { stopped = true })
    await new Promise(r => setTimeout(r, 600))
    unwatch()

    expect(stopped).toBe(false)
    expect(existsSync(join(dir, 'llm-fw.stop'))).toBe(false)
  })

  it('ignores a stop request naming a different process', async () => {
    let stopped = false
    const unwatch = watchForStopRequest(dir, process.pid, () => { stopped = true })

    writeFileSync(join(dir, 'llm-fw.stop'), String(process.pid + 1))
    await new Promise(r => setTimeout(r, 600))
    unwatch()

    expect(stopped).toBe(false)
  })

  it('removes a stale pid file whose process is already gone', async () => {
    const pidFile = join(dir, 'llm-fw.pid')
    // Far above any real pid limit, so the liveness probe fails.
    writeFileSync(pidFile, '2147483646')

    await run({ requestWaitMs: 300 })

    expect(existsSync(pidFile)).toBe(false)
  })
})
