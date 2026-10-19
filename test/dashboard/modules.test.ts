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

  it('lists the built-in modules with their description and enabled state', async () => {
    const res = await call('GET', '/api/modules')
    expect(res.status).toBe(200)
    expect(res.json.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'token-pruner', enabled: false, description: expect.any(String) }),
      expect.objectContaining({ id: 'usage-meter', enabled: true, kpis: expect.any(Array) }),
    ]))
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

  // Token Economy is the parent of every module: its switch is
  // modules.enabled, and turning it off leaves each module's own switch alone,
  // so turning it back on restores exactly what ran before.
  it('reports the Token Economy parent switch', async () => {
    const res = await call('GET', '/api/modules')
    expect(res.json.tokenEconomy).toEqual({ id: 'token-economy', name: 'Token Economy', enabled: true })
  })

  it('turns Token Economy off and on without touching the sub-modules, and persists it', async () => {
    const pruner = mgr.getModule('token-pruner')?.enabled
    const off = await call('POST', '/api/modules', JSON.stringify({ id: 'token-economy', enabled: false }))
    expect(off.status).toBe(200)
    expect(off.json.tokenEconomy.enabled).toBe(false)
    expect(config.modules?.enabled).toBe(false)
    expect(mgr.getModule('token-pruner')?.enabled).toBe(pruner)
    expect(JSON.parse(fs.readFileSync(join(tempDir, 'config.json'), 'utf8')).modules.enabled).toBe(false)
    expect((await call('GET', '/api/modules')).json.tokenEconomy.enabled).toBe(false)

    const on = await call('POST', '/api/modules', JSON.stringify({ id: 'token-economy', enabled: true }))
    expect(on.status).toBe(200)
    expect(config.modules?.enabled).toBe(true)
    expect(JSON.parse(fs.readFileSync(join(tempDir, 'config.json'), 'utf8')).modules.enabled).toBe(true)
  })

  // #354: a module's options could only be changed in config.json or the
  // environment. The card now lists them with their live values, and a POST
  // with `options` validates each against the module's schema, writes the
  // live config object the module reads, and persists it.
  it('lists each module\'s options with their type, bounds and live value', async () => {
    const res = await call('GET', '/api/modules')
    const window = res.json.modules.find((m: { id: string }) => m.id === 'history-window')
    expect(window.options).toEqual([
      { key: 'maxMessages', type: 'number', value: 100, min: 2, max: 100000 },
      { key: 'step', type: 'number', value: 25, min: 1, max: 100000 },
    ])
    const cache = res.json.modules.find((m: { id: string }) => m.id === 'cache-control')
    expect(cache.options).toEqual(expect.arrayContaining([
      { key: 'ttl', type: 'enum', value: '5m', values: ['5m', '1h'] },
      { key: 'cacheSystem', type: 'boolean', value: true },
    ]))
    const truncate = res.json.modules.find((m: { id: string }) => m.id === 'tool-result-truncate')
    expect(truncate.options).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'skipTools', type: 'list', value: expect.arrayContaining(['Read']) })]))
    expect(res.json.modules.find((m: { id: string }) => m.id === 'usage-meter').options).toEqual([])
  })

  it('changes a module\'s options live and persists them', async () => {
    const res = await call('POST', '/api/modules', JSON.stringify({ id: 'history-window', options: { maxMessages: 50, step: 10 } }))
    expect(res.status).toBe(200)
    expect(res.json.module.options).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'maxMessages', value: 50 })]))
    expect(config.modules?.historyWindow).toEqual({ enabled: false, maxMessages: 50, step: 10 })
    const saved = JSON.parse(fs.readFileSync(join(tempDir, 'config.json'), 'utf8'))
    expect(saved.modules.historyWindow).toEqual({ maxMessages: 50, step: 10 })

    // Both at once: the switch and an option.
    const both = await call('POST', '/api/modules', JSON.stringify({ id: 'tool-filter', enabled: true, options: { dropTools: [' NotebookEdit ', 'mcp__axiom__*'] } }))
    expect(both.status).toBe(200)
    expect(config.modules?.toolFilter).toEqual({ enabled: true, dropTools: ['NotebookEdit', 'mcp__axiom__*'] })
    expect(mgr.getModule('tool-filter')?.enabled).toBe(true)
  })

  it('refuses an option that is unknown, of the wrong type, out of bounds or the switch, and changes nothing', async () => {
    const before = structuredClone(config.modules)
    for (const [options, error] of [
      [{ maxMessages: 1 }, /maxMessages/],
      [{ maxMessages: '50' }, /maxMessages/],
      [{ maxMessages: 50.5 }, /maxMessages/],
      [{ windowSize: 50 }, /windowSize/],
      [{ enabled: true }, /enabled/],
      [{ step: 10, maxMessages: 0 }, /maxMessages/],
    ] as const) {
      const res = await call('POST', '/api/modules', JSON.stringify({ id: 'history-window', options }))
      expect(res.status, JSON.stringify(options)).toBe(400)
      expect(res.json.error).toMatch(error)
    }
    expect((await call('POST', '/api/modules', JSON.stringify({ id: 'cache-control', options: { ttl: '2h' } }))).status).toBe(400)
    expect((await call('POST', '/api/modules', JSON.stringify({ id: 'tool-filter', options: { dropTools: ['', 'x'] } }))).status).toBe(400)
    expect((await call('POST', '/api/modules', JSON.stringify({ id: 'tool-filter', options: 'x' }))).status).toBe(400)
    expect((await call('POST', '/api/modules', JSON.stringify({ id: 'tool-filter' }))).status).toBe(400)
    expect((await call('POST', '/api/modules', JSON.stringify({ id: 'no-such', options: { a: 1 } }))).status).toBe(404)
    expect(config.modules).toEqual(before)
  })

  // The dashboard fetches this summary every time its event stream opens and
  // renders whatever answers last. Without the flag, a page reloaded under
  // --observe said "% saved" for savings that were never applied.
  it('says whether the latest savings were applied or only a dry run', async () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Hello    world     again.' }] })
    const ctx = { target: 'api.openai.com', method: 'POST', path: '/v1/chat/completions', isLlmRequest: true, parser: null }

    await mgr.transformRequest(body, { ...ctx, dryRun: true })
    const observed = await call('GET', '/api/modules')
    expect(observed.json.applied).toBe(false)
    expect(observed.json.summary.applied).toBe(false)

    await mgr.transformRequest(body, ctx)
    const applied = await call('GET', '/api/modules')
    expect(applied.json.applied).toBe(true)
  })
})
