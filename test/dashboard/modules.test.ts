import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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

// The operator's way to empty the folder of stored originals and remembered
// outcomes from the dashboard (specs/001-tool-result-shunt: contracts/interfaces.md
// section 5, FR-025, SC-011, D9, US7-6). The folder is `<LLM_FW_DIR>/tool-results`.
describe('POST /api/modules/tool-result-shunt/purge', () => {
  const PURGE = '/api/modules/tool-result-shunt/purge'
  const savedDir = process.env.LLM_FW_DIR
  let tempDir: string
  let server: http.Server
  let port = 0
  let mgr: ModuleManager

  const folder = () => join(tempDir, 'tool-results')
  const listing = () => (fs.existsSync(folder()) ? fs.readdirSync(folder()).sort() : [])

  /** What the module leaves there: originals, outcome files and the temp file of an interrupted write. */
  function fillFolder(): string[] {
    const hex = (c: string) => c.repeat(64)
    const names = [`${hex('a')}.txt`, `${hex('b')}.txt`, `${hex('c')}.outcome`, `${hex('d')}.outcome`, `${hex('e')}.0f3a9c1d.tmp`]
    fs.mkdirSync(folder(), { recursive: true })
    for (const name of names) fs.writeFileSync(join(folder(), name), `content of ${name}`)
    return names.sort()
  }

  function post(path: string, headers: Record<string, string> = { 'content-type': 'application/json' }, body = '{}'): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, method: 'POST', path,
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      }, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }))
      })
      r.on('error', reject)
      r.write(body)
      r.end()
    })
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shunt-purge-'))
    process.env.LLM_FW_DIR = tempDir
    const config = structuredClone(DEFAULT_CONFIG) as Config
    mgr = new ModuleManager(config)
    server = createDashboardServer(config, new EventBus(config.dashboard), undefined as any, undefined, undefined, mgr)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (savedDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = savedDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    fs.rmSync(folder(), { recursive: true, force: true })
  })

  it('empties the folder, outcome files and a stray temp file included, and answers how many files it deleted (FR-025, SC-011, US7-6)', async () => {
    expect(fillFolder()).toHaveLength(5)
    const res = await post(PURGE)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, deleted: 5 })
    expect(listing()).toEqual([])
  })

  it('answers 200 with 0 deleted when there is nothing to delete, with or without the folder (FR-025)', async () => {
    expect(await post(PURGE)).toEqual({ status: 200, json: { ok: true, deleted: 0 } })
    fs.mkdirSync(folder(), { recursive: true })
    expect(await post(PURGE)).toEqual({ status: 200, json: { ok: true, deleted: 0 } })
  })

  it('refuses a request that is not JSON with 415, as POST /api/modules does, and deletes nothing (contracts section 5)', async () => {
    const names = fillFolder()
    const res = await post(PURGE, { 'content-type': 'text/plain' }, 'x')
    expect(res.status).toBe(415)
    expect(res.json).toEqual({ error: 'Content-Type must be application/json' })
    expect(listing()).toEqual(names)
  })

  it('refuses a cross-origin request with 403, as POST /api/modules does, and deletes nothing; a request from the dashboard\'s own origin is served (contracts section 5)', async () => {
    const names = fillFolder()
    const cross = await post(PURGE, { 'content-type': 'application/json', origin: 'http://evil.example' })
    expect(cross.status).toBe(403)
    expect(cross.json).toEqual({ error: 'cross-origin request blocked' })
    const crossReferer = await post(PURGE, { 'content-type': 'application/json', referer: 'http://evil.example/page' })
    expect(crossReferer.status).toBe(403)
    expect(listing()).toEqual(names)

    const same = await post(PURGE, { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` })
    expect(same.status).toBe(200)
    expect(same.json).toEqual({ ok: true, deleted: 5 })
    expect(listing()).toEqual([])
  })

  it.each([true, false])('leaves the module\'s enabled flag as it was, switched on: %s (contracts section 5)', async enabled => {
    expect(mgr.setModuleEnabled('tool-result-shunt', enabled)).toBe(true)
    fillFolder()
    const res = await post(PURGE)
    expect(res.status).toBe(200)
    expect(mgr.getModule('tool-result-shunt')?.enabled).toBe(enabled)
    expect(listing()).toEqual([])
  })

  it('carries the card\'s "Delete stored originals" button in the dashboard page, posting to the purge route (contracts section 5)', async () => {
    const { DASHBOARD_HTML } = await import('../../src/dashboard/server.js')
    expect(DASHBOARD_HTML).toContain('Delete stored originals')
    expect(DASHBOARD_HTML).toContain('tool-result-shunt')
    expect(DASHBOARD_HTML).toContain('/purge')
  })
})
