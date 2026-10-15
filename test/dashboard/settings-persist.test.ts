import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDashboardServer } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { ModuleManager } from '../../src/modules/registry.js'
import { applyObserveMode, loadConfig } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

/**
 * What a dashboard toggle writes to config.json.
 *
 * persistSettings used to write a snapshot of the whole live config. Live
 * config is not file config: `start --observe` relaxes every stage mode in
 * memory, and LLM_FW_* variables override the file. So toggling one switch
 * while observing wrote dlp.mode "audit" (and up to four more relaxed modes)
 * to disk, and the firewall stayed relaxed after a restart without --observe.
 * Found while live-testing the token pruner (#340).
 */
describe('dashboard settings persistence writes only what changed', () => {
  let tempDir: string
  let server: http.Server
  let port = 0
  const savedEnv = process.env.LLM_FW_TOKEN_PRUNER_ENABLED

  function post(path: string, body: unknown): Promise<number> {
    const payload = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, method: 'POST', path,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
      r.on('error', reject)
      r.end(payload)
    })
  }

  async function serve(config: Config): Promise<void> {
    server = createDashboardServer(config, new EventBus(config.dashboard), undefined as any, undefined, undefined, new ModuleManager(config))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  }

  const saved = (): any => JSON.parse(fs.readFileSync(join(tempDir, 'config.json'), 'utf8'))

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-settings-persist-'))
    process.env.LLM_FW_DIR = tempDir
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    delete process.env.LLM_FW_DIR
    if (savedEnv === undefined) delete process.env.LLM_FW_TOKEN_PRUNER_ENABLED
    else process.env.LLM_FW_TOKEN_PRUNER_ENABLED = savedEnv
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('a toggle under --observe does not persist the observe-relaxed modes', async () => {
    fs.writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ dlp: { mode: 'block' }, crescendo: { mode: 'block' } }))
    const config = await loadConfig()
    applyObserveMode(config)
    expect(config.dlp.mode).toBe('audit')
    await serve(config)

    expect(await post('/api/settings', { tokenPruner: true })).toBe(200)

    expect(saved().modules.tokenPruner.enabled).toBe(true)
    expect(saved().dlp.mode).toBe('block')
    expect(saved().crescendo.mode).toBe('block')
  })

  it('a module toggle under --observe does not persist the observe-relaxed modes either', async () => {
    fs.writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ dlp: { mode: 'block' } }))
    const config = await loadConfig()
    applyObserveMode(config)
    await serve(config)

    expect(await post('/api/modules', { id: 'token-pruner', enabled: true })).toBe(200)

    expect(saved().modules.tokenPruner.enabled).toBe(true)
    expect(saved().dlp.mode).toBe('block')
  })

  it('does not copy an environment-pinned value into the file', async () => {
    process.env.LLM_FW_TOKEN_PRUNER_ENABLED = 'true'
    const config = await loadConfig()
    expect(config.modules?.tokenPruner.enabled).toBe(true)
    await serve(config)

    expect(await post('/api/settings', { dlp: false })).toBe(200)

    expect(saved().dlp.enabled).toBe(false)
    expect(saved().modules?.tokenPruner?.enabled).toBeUndefined()
  })
})
