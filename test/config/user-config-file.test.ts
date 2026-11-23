import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, DEFAULT_CONFIG, writeUserConfigFile } from '../../src/config/config.js'

// #853: a typo in <LLM_FW_DIR>/config.json (a trailing comma) made loadConfig
// start on the defaults without a word, dropping the operator's auth token,
// tenants, audit log, extra targets, trusted paths and sinkhole mode.
describe('loadConfig on a config.json it cannot use (#853)', () => {
  let dir: string
  const saved = process.env.LLM_FW_DIR

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-user-config-'))
    process.env.LLM_FW_DIR = dir
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a file that is not valid JSON, naming it', async () => {
    fs.writeFileSync(join(dir, 'config.json'), '{ "proxy": { "authToken": "t" }, }')
    await expect(loadConfig()).rejects.toThrow(join(dir, 'config.json'))
    await expect(loadConfig()).rejects.toThrow(/not valid JSON/)
  })

  it.each(['[]', 'null', '"proxy"', '42'])('refuses a file that holds %s rather than an object', async (text) => {
    fs.writeFileSync(join(dir, 'config.json'), text)
    await expect(loadConfig()).rejects.toThrow(/JSON object/)
  })

  it('starts on the defaults when there is no file', async () => {
    const config = await loadConfig()
    expect(config.proxy.port).toBe(DEFAULT_CONFIG.proxy.port)
  })

  it('still reads a valid file', async () => {
    fs.writeFileSync(join(dir, 'config.json'), JSON.stringify({ proxy: { port: 18999 } }))
    expect((await loadConfig()).proxy.port).toBe(18999)
  })
})

// #864: config.json was written in place with writeFileSync, so the hot-reload
// watcher could read it half written, and it took the default 0644 mode while
// it can hold the proxy and gateway tokens. It is now written to a temporary
// file beside it and renamed over, with mode 0600.
describe('writeUserConfigFile (#864)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-write-config-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('replaces the file whole and leaves nothing beside it', () => {
    const file = join(dir, 'config.json')
    fs.writeFileSync(file, JSON.stringify({ old: true }))
    writeUserConfigFile(file, { proxy: { mode: 'proxy' } })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ proxy: { mode: 'proxy' } })
    expect(fs.readdirSync(dir)).toEqual(['config.json'])
  })

  it('creates the directory it goes in', () => {
    const file = join(dir, 'nested', 'config.json')
    writeUserConfigFile(file, { a: 1 })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 })
  })

  it.runIf(process.platform !== 'win32')('is readable by its owner only', () => {
    const file = join(dir, 'config.json')
    writeUserConfigFile(file, { proxy: { authToken: 'secret' } })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
