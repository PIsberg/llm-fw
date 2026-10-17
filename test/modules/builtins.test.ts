import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BUILTINS, ModuleManager } from '../../src/modules/registry.js'
import { DEFAULT_CONFIG, loadConfig } from '../../src/config/config.js'
import { applyHotReload } from '../../src/config/hotReload.js'
import type { Config } from '../../src/types.js'

// A module is five edits (type, default, env override, hot-reload path,
// docs). This walks every built-in so a module that misses one fails here
// rather than in a user's hands.

// Modules that only read and may therefore be on by default.
const READ_ONLY = new Set(['usageMeter'])
// A different valid value for each string option, for the hot-reload check.
const OTHER_STRING: Record<string, string> = { ttl: '1h' }

const snake = (key: string) => key.replace(/[A-Z]/g, c => '_' + c).toUpperCase()
const options = (key: string) => Object.entries((DEFAULT_CONFIG.modules as unknown as Record<string, Record<string, unknown>>)[key]!)

describe.each(BUILTINS.map((b, i) => [b.key, i] as const))('built-in module %s', (key, index) => {
  const savedDir = process.env.LLM_FW_DIR
  const envName = `LLM_FW_${snake(key)}_ENABLED`
  afterEach(() => {
    delete process.env[envName]
    if (savedDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = savedDir
  })

  it('has a default, and is off unless it only reads', () => {
    const defaults = Object.fromEntries(options(key))
    expect(defaults.enabled).toBe(READ_ONLY.has(key))
  })

  it(`is switched by ${envName}`, async () => {
    process.env.LLM_FW_DIR = fs.mkdtempSync(join(tmpdir(), 'llm-fw-builtins-'))
    const flipped = !READ_ONLY.has(key)
    process.env[envName] = String(flipped)
    const cfg = await loadConfig()
    expect((cfg.modules as unknown as Record<string, { enabled: boolean }>)[key]!.enabled).toBe(flipped)
  })

  it('takes every option live from a hot reload', () => {
    const live = structuredClone(DEFAULT_CONFIG) as Config
    const mgr = new ModuleManager(live)
    const mod = mgr.listModules()[index]!
    const incoming = structuredClone(live)
    const slot = (incoming.modules as unknown as Record<string, Record<string, unknown>>)[key]!
    for (const [name, value] of options(key)) {
      slot[name] = typeof value === 'boolean' ? !value
        : typeof value === 'number' ? value + 1
        : Array.isArray(value) ? [...value, 'changed']
        : OTHER_STRING[name] ?? `${String(value)}-changed`
    }
    applyHotReload(live, incoming, () => {})
    expect((live.modules as unknown as Record<string, unknown>)[key]).toEqual(slot)
    expect(mod.enabled).toBe(slot.enabled)
  })
})
