import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, DEFAULT_CONFIG } from '../../src/config/config.js'

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
