import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModuleManager } from '../../src/modules/registry.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { createDashboardServer, DASHBOARD_HTML } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import type { Config } from '../../src/types.js'

const ctx = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null, sessionKey: 's1' }
const body = (text: string) => JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: text }] })

describe('/api/prompts', () => {
  let tempDir: string
  let server: http.Server
  let port = 0
  let mgr: ModuleManager

  function call(method: string, path: string, payload?: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, method, path,
        headers: { 'content-type': 'application/json', ...(payload ? { 'content-length': String(Buffer.byteLength(payload)) } : {}) },
      }, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }))
      })
      r.on('error', reject)
      if (payload) r.write(payload)
      r.end()
    })
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-prompts-api-'))
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
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('reports the monitor off, with nothing held, by default', async () => {
    const res = await call('GET', '/api/prompts')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ enabled: false, total: 0, entries: [] })
  })

  it('opts in over /api/modules, then lists, searches and filters what passes', async () => {
    expect((await call('POST', '/api/modules', JSON.stringify({ id: 'prompt-monitor', enabled: true }))).status).toBe(200)
    await mgr.transformRequest(body('Refactor the parser'), ctx)
    await mgr.transformRequest(body('write a haiku'), { ...ctx, sessionKey: 's2' })

    const all = await call('GET', '/api/prompts')
    expect(all.json).toMatchObject({ enabled: true, total: 2 })
    expect(all.json.entries.map((e: any) => e.text)).toEqual(['write a haiku', 'Refactor the parser'])

    expect((await call('GET', '/api/prompts?q=PARSER')).json.total).toBe(1)
    expect((await call('GET', '/api/prompts?session=s2')).json.entries[0].text).toBe('write a haiku')
    expect((await call('GET', '/api/prompts?limit=1&offset=1')).json.entries[0].text).toBe('Refactor the parser')
    expect(all.json.facets.sessions.sort()).toEqual(['s1', 's2'])
  })

  it('clears what is held, and stays on', async () => {
    expect((await call('POST', '/api/prompts/clear', '{}')).json).toEqual({ ok: true })
    const res = await call('GET', '/api/prompts')
    expect(res.json).toMatchObject({ enabled: true, total: 0 })
  })

  it('opting out drops the held prompts', async () => {
    await mgr.transformRequest(body('private thought'), ctx)
    expect((await call('GET', '/api/prompts')).json.total).toBe(1)
    await call('POST', '/api/modules', JSON.stringify({ id: 'prompt-monitor', enabled: false }))
    expect(await call('GET', '/api/prompts')).toMatchObject({ json: { enabled: false, total: 0, entries: [] } })
  })

  it('refuses a clear from another origin', async () => {
    const res = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/prompts/clear', headers: { 'content-type': 'application/json', origin: 'http://evil.example' } },
        res => { res.resume(); resolve(res.statusCode ?? 0) })
      r.on('error', reject)
      r.end('{}')
    })
    expect(res).toBeGreaterThanOrEqual(400)
  })

  it('has a Prompts tab with a search box and filters', () => {
    expect(DASHBOARD_HTML).toContain('id="tab-prompts"')
    expect(DASHBOARD_HTML).toContain('id="prompts-search"')
    expect(DASHBOARD_HTML).toContain('id="prompts-target"')
    expect(DASHBOARD_HTML).toContain('id="prompts-model"')
    expect(DASHBOARD_HTML).toContain('id="prompts-session"')
  })
})
