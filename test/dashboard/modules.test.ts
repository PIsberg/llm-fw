import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModuleManager } from '../../src/modules/registry.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { createDashboardServer } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import type { Config } from '../../src/types.js'

function enabledConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG) as Config
  config.modules!.tokenPruner.enabled = true
  return config
}

describe('Dashboard & Config — Module settings wiring', () => {
  it('ModuleManager registers token-pruner from config', () => {
    const config = enabledConfig()
    const mgr = new ModuleManager(config)

    const pruner = mgr.getModule('token-pruner')
    expect(pruner).toBeDefined()
    expect(pruner?.enabled).toBe(true)

    // Toggle off, and the config the dashboard persists follows.
    mgr.setModuleEnabled('token-pruner', false)
    expect(pruner?.enabled).toBe(false)
    expect(config.modules?.tokenPruner.enabled).toBe(false)
  })

  it('aggregates live metrics from token-pruner', async () => {
    const config = enabledConfig()
    const mgr = new ModuleManager(config)

    const input = JSON.stringify({
      messages: [{ role: 'user', content: 'Hello    world     from    test.' }],
    })

    const res = await mgr.transformRequest(input, {
      target: 'api.openai.com',
      method: 'POST',
      path: '/v1/chat/completions',
      isLlmRequest: true,
      parser: null,
    })

    expect(res.modified).toBe(true)
    expect(res.events).toHaveLength(1)
    expect(res.events[0]?.tokensSaved).toBeGreaterThan(0)

    const summary = mgr.getSummaryStats()
    expect(summary.totalTokensSaved).toBeGreaterThan(0)
    expect(summary.overallPercentSaved).toBeGreaterThan(0)
  })

  it('dashboard HTML contains tokens saved card, SSE listener, and settings toggle', async () => {
    const { DASHBOARD_HTML } = await import('../../src/dashboard/server.js')
    expect(DASHBOARD_HTML).toContain('id="stat-tokens-saved"')
    expect(DASHBOARD_HTML).toContain('id="stat-tokens-pct"')
    expect(DASHBOARD_HTML).toContain("es.addEventListener('module'")
    expect(DASHBOARD_HTML).toContain("key: 'tokenPruner'")
    expect(DASHBOARD_HTML).toContain('Token Pruner / Cost Optimizer')
  })

  it('EventBus emits and replays module events to subscribers', async () => {
    const { EventBus } = await import('../../src/dashboard/eventBus.js')
    const bus = new EventBus({ maxEvents: 100 } as any)

    const received: string[] = []
    const fakeRes = {
      writeHead: () => {},
      write: (data: string) => { received.push(data) },
      on: () => {},
    } as any

    const moduleEvent = {
      moduleId: 'token-pruner',
      tokensSaved: 10,
      totalTokensSaved: 100,
      overallPercentSaved: 15.5,
      timestamp: new Date().toISOString(),
    }

    bus.emitModuleEvent(moduleEvent)
    expect(bus.getRecentModuleEvents()).toEqual([moduleEvent])

    // Subscribe replays recent module event
    bus.subscribe(fakeRes)
    expect(received.some(chunk => chunk.includes('event: module') && chunk.includes('token-pruner'))).toBe(true)
  })
})

describe('/api/modules', () => {
  let tempDir: string
  let server: http.Server
  let port = 0
  let config: Config
  let mgr: ModuleManager

  function call(method: string, path: string, body?: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, method, path,
        headers: { 'content-type': 'application/json', ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}) },
      }, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }))
      })
      r.on('error', reject)
      if (body) r.write(body)
      r.end()
    })
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-modules-api-'))
    process.env.LLM_FW_DIR = tempDir
    config = structuredClone(DEFAULT_CONFIG) as Config
    mgr = new ModuleManager(config)
    server = createDashboardServer(config, new EventBus(config.dashboard), undefined as any, undefined, undefined, mgr)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('lists the built-in module with its description and enabled state', async () => {
    const res = await call('GET', '/api/modules')
    expect(res.status).toBe(200)
    expect(res.json.modules).toEqual([
      expect.objectContaining({ id: 'token-pruner', enabled: false, description: expect.any(String) }),
    ])
  })

  it('answers 404 for a module id that is not registered, and changes nothing', async () => {
    const res = await call('POST', '/api/modules', JSON.stringify({ id: 'no-such-module', enabled: true }))
    expect(res.status).toBe(404)
    expect(fs.existsSync(join(tempDir, 'config.json'))).toBe(false)
  })

  it('toggles a module live and persists it to config.json', async () => {
    const res = await call('POST', '/api/modules', JSON.stringify({ id: 'token-pruner', enabled: true }))
    expect(res.status).toBe(200)
    expect(mgr.getModule('token-pruner')?.enabled).toBe(true)
    const saved = JSON.parse(fs.readFileSync(join(tempDir, 'config.json'), 'utf8'))
    expect(saved.modules.tokenPruner.enabled).toBe(true)
  })
})
