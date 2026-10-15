import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run as status } from '../../src/cli/status.js'
import { readRuntimeState, writeRuntimeState, type RuntimeState } from '../../src/cli/runtimeState.js'

/**
 * `llm-fw status` used to read only config.json and the pid file, so a process
 * started with `--observe` or `--gateway` looked exactly like a plain one:
 * nothing said the firewall was blocking nothing, or that a gateway was
 * listening (#320, found in a live install test 2026-10-12). Those flags live
 * in memory, so the running process now records what it actually started.
 */
const STATE: RuntimeState = {
  pid: process.pid,
  startedAt: '2026-10-15T20:00:00.000Z',
  enforcement: 'observe',
  proxyUrl: 'http://127.0.0.1:18080',
  dashboardUrl: 'http://127.0.0.1:17731',
  gatewayUrl: 'http://127.0.0.1:18081',
  sinkhole: false,
}

let tempDir: string
let lines: string[]

beforeEach(() => {
  tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-status-'))
  process.env.LLM_FW_DIR = tempDir
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.LLM_FW_DIR
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('runtime state', () => {
  it('round-trips for the process that wrote it', () => {
    writeRuntimeState(tempDir, STATE)
    expect(readRuntimeState(tempDir, process.pid)).toEqual(STATE)
  })

  it('is ignored when it belongs to another pid (a stale file from a crashed run)', () => {
    writeRuntimeState(tempDir, { ...STATE, pid: process.pid + 1 })
    expect(readRuntimeState(tempDir, process.pid)).toBeNull()
  })

  it('is ignored when it is not valid JSON', () => {
    fs.writeFileSync(join(tempDir, 'llm-fw.state.json'), '{ not json')
    expect(readRuntimeState(tempDir, process.pid)).toBeNull()
  })
})

describe('llm-fw status', () => {
  it('says an observe-mode process blocks nothing, and names the gateway', async () => {
    fs.writeFileSync(join(tempDir, 'llm-fw.pid'), String(process.pid))
    writeRuntimeState(tempDir, STATE)

    await status()
    const out = lines.join('\n')
    expect(out).toContain('llm-fw: running')
    expect(out).toMatch(/Enforcement:\s+observe \(nothing is blocked\)/)
    expect(out).toMatch(/Gateway:\s+http:\/\/127\.0\.0\.1:18081/)
    expect(out).toMatch(/Proxy:\s+http:\/\/127\.0\.0\.1:18080/)
    expect(out).toMatch(/Dashboard:\s+http:\/\/127\.0\.0\.1:17731/)
  })

  it('reports an enforcing process without a gateway as such', async () => {
    fs.writeFileSync(join(tempDir, 'llm-fw.pid'), String(process.pid))
    writeRuntimeState(tempDir, { ...STATE, enforcement: 'enforce', gatewayUrl: null })

    await status()
    const out = lines.join('\n')
    expect(out).toMatch(/Enforcement:\s+enforce/)
    expect(out).toMatch(/Gateway:\s+off/)
  })

  it('still reports a running process that predates the state file', async () => {
    fs.writeFileSync(join(tempDir, 'llm-fw.pid'), String(process.pid))

    await status()
    const out = lines.join('\n')
    expect(out).toContain('llm-fw: running')
    expect(out).toMatch(/Enforcement:\s+unknown/)
  })
})
