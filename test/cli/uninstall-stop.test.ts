import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopRunningProxy } from '../../src/cli/uninstall.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * `llm-fw uninstall` stops a running firewall before removing its files. It
 * sent SIGTERM itself, which on Windows is TerminateProcess, so the graceful
 * shutdown `llm-fw stop` gained in #310 (audit flush, hosts and portproxy
 * cleanup) never ran: found live on 2026-10-12, the uninstalled process
 * exited 1. It must stop the process the way `llm-fw stop` does.
 */
describe('uninstall stops a running firewall gracefully', () => {
  let dir: string
  let prevDir: string | undefined
  let child: ChildProcess | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llm-fw-uninstall-stop-'))
    prevDir = process.env.LLM_FW_DIR
    process.env.LLM_FW_DIR = dir
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try { child?.kill('SIGKILL') } catch { /* already dead */ }
    if (prevDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('lets the process run its cleanup and exit 0', async () => {
    child = spawn(process.execPath, ['--import', 'tsx/esm', join(REPO, 'test', 'cli', 'fixtures', 'stop-watcher-child.ts')], {
      cwd: REPO,
      env: { ...process.env, LLM_FW_DIR: dir },
      stdio: 'ignore',
    })
    const exited = new Promise<number | null>(resolve => child!.on('exit', code => resolve(code)))
    const readyBy = Date.now() + 15_000
    while (!existsSync(join(dir, 'ready')) && Date.now() < readyBy) await new Promise(r => setTimeout(r, 50))

    await stopRunningProxy(dir)

    expect(await exited).toBe(0)
    expect(existsSync(join(dir, 'cleaned-up'))).toBe(true)
    expect(existsSync(join(dir, 'llm-fw.pid'))).toBe(false)
  }, 30_000)
})
