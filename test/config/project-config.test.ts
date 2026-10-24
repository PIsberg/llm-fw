import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../../src/config/config.js'

// GHSA-4578-7p8f-hc8r. The working directory is not a trusted place: running
// llm-fw inside a cloned repository used to load that repository's
// `.llm-fwrc.js` (code execution) and its `.llm-fw.json` or package.json
// "llm-fw" key, which could switch enforcement to observe or bind the proxy
// to every interface without auth. A project file is now read only when
// LLM_FW_CONFIG names it.
describe('loadConfig: the working directory is not a config source', () => {
  let cwd: string
  let fwDir: string
  const saved = { dir: process.env.LLM_FW_DIR, config: process.env.LLM_FW_CONFIG }

  beforeEach(() => {
    cwd = fs.mkdtempSync(join(tmpdir(), 'llm-fw-cwd-'))
    fwDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-dir-'))
    process.env.LLM_FW_DIR = fwDir
    delete process.env.LLM_FW_CONFIG
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    delete (globalThis as Record<string, unknown>).__llmFwConfigRan
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (saved.dir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = saved.dir
    if (saved.config === undefined) delete process.env.LLM_FW_CONFIG
    else process.env.LLM_FW_CONFIG = saved.config
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(fwDir, { recursive: true, force: true })
  })

  const hostile = { enforcement: 'observe', proxy: { bindHost: '0.0.0.0', requireAuth: false } }

  it('does not execute a JavaScript config file in the working directory', async () => {
    for (const name of ['.llm-fwrc.js', 'llm-fw.config.js']) {
      fs.writeFileSync(join(cwd, name), `globalThis.__llmFwConfigRan = true; module.exports = ${JSON.stringify(hostile)}`)
    }
    const cfg = await loadConfig()
    expect((globalThis as Record<string, unknown>).__llmFwConfigRan).toBeUndefined()
    expect(cfg.enforcement).not.toBe('observe')
    expect(cfg.proxy.bindHost).toBe('127.0.0.1')
  })

  it('ignores .llm-fw.json, .llm-fwrc and a package.json "llm-fw" key in the working directory', async () => {
    for (const [name, body] of [
      ['.llm-fw.json', hostile],
      ['.llm-fwrc', hostile],
      ['.llm-fwrc.json', hostile],
      ['package.json', { name: 'cloned', 'llm-fw': hostile }],
    ] as const) {
      fs.writeFileSync(join(cwd, name), JSON.stringify(body))
      const cfg = await loadConfig()
      expect(cfg.enforcement, name).not.toBe('observe')
      expect(cfg.proxy.bindHost, name).toBe('127.0.0.1')
      expect(cfg.proxy.requireAuth, name).not.toBe(false)
      fs.rmSync(join(cwd, name))
    }
  })

  it('loads a JSON project file named by LLM_FW_CONFIG, beneath <LLM_FW_DIR>/config.json and the environment', async () => {
    const file = join(cwd, 'team.json')
    fs.writeFileSync(file, JSON.stringify({ proxy: { port: 9100 }, dashboard: { port: 7100 }, dos: { maxRequestsPerMinute: 5 } }))
    fs.writeFileSync(join(fwDir, 'config.json'), JSON.stringify({ dashboard: { port: 7200 } }))
    process.env.LLM_FW_CONFIG = file
    process.env.LLM_FW_DOS_MAX_RPM = '7'
    try {
      const cfg = await loadConfig()
      expect(cfg.proxy.port).toBe(9100)
      expect(cfg.dashboard.port).toBe(7200)
      expect(cfg.dos.maxRequestsPerMinute).toBe(7)
    } finally {
      delete process.env.LLM_FW_DOS_MAX_RPM
    }
  })

  it('fails loudly when LLM_FW_CONFIG names a missing, unparsable or non-JSON file', async () => {
    process.env.LLM_FW_CONFIG = join(cwd, 'missing.json')
    await expect(loadConfig()).rejects.toThrow(/LLM_FW_CONFIG/)

    fs.writeFileSync(join(cwd, 'broken.json'), '{ not json')
    process.env.LLM_FW_CONFIG = join(cwd, 'broken.json')
    await expect(loadConfig()).rejects.toThrow(/LLM_FW_CONFIG/)

    fs.writeFileSync(join(cwd, 'cfg.js'), 'globalThis.__llmFwConfigRan = true; module.exports = {}')
    process.env.LLM_FW_CONFIG = join(cwd, 'cfg.js')
    await expect(loadConfig()).rejects.toThrow(/LLM_FW_CONFIG/)
    expect((globalThis as Record<string, unknown>).__llmFwConfigRan).toBeUndefined()
  })

  it('names a project file it ignored, and how to use it', async () => {
    fs.writeFileSync(join(cwd, '.llm-fw.json'), JSON.stringify({ proxy: { port: 9100 } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadConfig()
    const said = warn.mock.calls.map(c => c.join(' ')).join('\n')
    expect(said).toContain('.llm-fw.json')
    expect(said).toContain('Set LLM_FW_CONFIG=')
  })

  it('tells the owner of a JavaScript config to convert it, not to point at it', async () => {
    fs.writeFileSync(join(cwd, '.llm-fwrc.js'), 'module.exports = {}')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadConfig()
    const said = warn.mock.calls.map(c => c.join(' ')).join('\n')
    expect(said).toContain('.llm-fwrc.js')
    expect(said).toContain('convert it to a .json file')
    expect(said).not.toContain('Set LLM_FW_CONFIG=')
  })
})
