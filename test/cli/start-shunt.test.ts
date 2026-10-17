import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startShuntSweep } from '../../src/cli/start.js'
import { ModuleManager } from '../../src/modules/registry.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

// The hourly sweep of the tool result shunt's folder, started by `llm-fw start`
// whether or not the module is on (specs/001-tool-result-shunt: FR-025, US7-5).
// Every test runs against a scratch LLM_FW_DIR, as test/modules/shuntStore.test.ts
// does, so the real ~/.llm-fw is never touched.

const HOUR = 3_600_000
const savedDir = process.env.LLM_FW_DIR

let root: string
let config: Config
let modules: ModuleManager
let stop: (() => void) | undefined

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shunt-sweep-'))
  process.env.LLM_FW_DIR = root
  config = structuredClone(DEFAULT_CONFIG) as Config
  modules = new ModuleManager(config)
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  if (savedDir === undefined) delete process.env.LLM_FW_DIR
  else process.env.LLM_FW_DIR = savedDir
  fs.rmSync(root, { recursive: true, force: true })
})

const folder = () => join(root, 'tool-results')
const hex = (c: string) => c.repeat(64)

/** A file of the shunt's folder whose mtime is `ageMs` before the clock `Date.now()` reads. */
function plant(name: string, ageMs: number): string {
  fs.mkdirSync(folder(), { recursive: true })
  const path = join(folder(), name)
  fs.writeFileSync(path, 'x')
  const mtime = new Date(Date.now() - ageMs)
  fs.utimesSync(path, mtime, mtime)
  return path
}

/** Poll with the real clock, which `vi.useFakeTimers({ toFake: [...] })` below leaves alone. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10))
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('startShuntSweep (FR-025, US7-5)', () => {
  it('deletes expired stored originals and outcome files at once, with the module off, and keeps unexpired ones', async () => {
    expect(modules.getModule('tool-result-shunt')!.enabled).toBe(false)
    const expiredOriginal = plant(`${hex('a')}.txt`, 25 * HOUR)
    const expiredOutcome = plant(`${hex('b')}.outcome`, 25 * HOUR)
    const nearlyExpired = plant(`${hex('c')}.txt`, 23 * HOUR)
    const fresh = plant(`${hex('d')}.outcome`, 0)

    stop = startShuntSweep(modules, config)
    await until(() => !fs.existsSync(expiredOriginal) && !fs.existsSync(expiredOutcome))

    expect(fs.existsSync(expiredOriginal)).toBe(false)
    expect(fs.existsSync(expiredOutcome)).toBe(false)
    expect(fs.existsSync(nearlyExpired)).toBe(true)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('creates no folder when there is nothing to sweep', async () => {
    stop = startShuntSweep(modules, config)
    await pause(200)
    expect(fs.existsSync(folder())).toBe(false)
  })

  it('sweeps again at the next hourly sweep, judging by retentionHours as it is then (FR-025)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const shunt = config.modules!.toolResultShunt!
    expect(shunt.retentionHours).toBe(24)
    // Not expired under 24 hours; the sentinel is, and its going shows the first sweep has run.
    const sentinel = plant(`${hex('e')}.txt`, 25 * HOUR)
    const later = plant(`${hex('f')}.txt`, 2 * HOUR)

    stop = startShuntSweep(modules, config)
    await until(() => !fs.existsSync(sentinel))
    expect(fs.existsSync(sentinel)).toBe(false)
    expect(fs.existsSync(later)).toBe(true)

    // The operator shortens the retention live. A sweep that kept the value it was started with would never delete the file.
    shunt.retentionHours = 1
    vi.advanceTimersByTime(HOUR)
    await until(() => !fs.existsSync(later))
    expect(fs.existsSync(later)).toBe(false)
  })

  it('does not sweep again once the returned stop has run', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const sentinel = plant(`${hex('1')}.txt`, 25 * HOUR)

    const stopSweep = startShuntSweep(modules, config)
    stop = stopSweep
    await until(() => !fs.existsSync(sentinel))
    expect(fs.existsSync(sentinel)).toBe(false)

    stopSweep()
    const late = plant(`${hex('2')}.txt`, 25 * HOUR)
    vi.advanceTimersByTime(3 * HOUR)
    await pause(300)
    expect(fs.existsSync(late)).toBe(true)
  })

  it('returns a stop that does nothing for a manager without the module', async () => {
    const expired = plant(`${hex('3')}.txt`, 25 * HOUR)
    const none = new ModuleManager(config, false)
    expect(none.getModule('tool-result-shunt')).toBeUndefined()

    const stopNothing = startShuntSweep(none, config)
    expect(typeof stopNothing).toBe('function')
    stopNothing()
    await pause(200)
    expect(fs.existsSync(expired)).toBe(true)
  })
})
