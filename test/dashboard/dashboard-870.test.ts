import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDashboardServer } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG, loadConfig } from '../../src/config/config.js'
import { listenersToStart } from '../../src/cli/start.js'
import type { Config } from '../../src/types.js'

// #870: the dashboard exempted loopback whatever its configuration, a live
// URL-filter toggle did not reach the playground, and Helm's proxy.enabled and
// dashboard.enabled only dropped a Service port while start bound both anyway.

function serve(config: Config): Promise<{ server: http.Server; port: number }> {
  const server = createDashboardServer(config, new EventBus(config.dashboard), undefined as never)
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port })))
}
function send(port: number, path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; headers.Origin = `http://127.0.0.1:${port}` }
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body))
  })
}

describe('dashboard.requireAuth (#870)', () => {
  let dir: string
  const servers: http.Server[] = []
  beforeAll(() => { dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-870-')); process.env.LLM_FW_DIR = dir })
  afterAll(async () => {
    for (const s of servers) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())) }
    delete process.env.LLM_FW_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('true: a caller on this machine needs the token too', async () => {
    const config = structuredClone(DEFAULT_CONFIG) as Config
    config.dashboard.requireAuth = true
    config.dashboard.authToken = 'dash-870'
    const { server, port } = await serve(config); servers.push(server)
    expect((await send(port, '/api/settings')).status).toBe(401)
    expect((await send(port, '/api/settings', { token: 'dash-870' })).status).toBe(200)
  })

  it('unset: a caller on this machine is trusted, as before', async () => {
    const config = structuredClone(DEFAULT_CONFIG) as Config
    const { server, port } = await serve(config); servers.push(server)
    expect((await send(port, '/api/settings')).status).toBe(200)
  })

  it('the playground reads the URL filter as it is now, not as it was at startup', async () => {
    const config = structuredClone(DEFAULT_CONFIG) as Config
    config.proxy.urlFilter = { ...config.proxy.urlFilter, enabled: false }
    const { server, port } = await serve(config); servers.push(server)
    const before = JSON.parse((await send(port, '/api/test', { method: 'POST', body: { category: 'url', url: 'https://webhook.site/abc?d=1' } })).body)
    expect(before.reason).toBe('url-filter-disabled')
    config.proxy.urlFilter = { ...config.proxy.urlFilter, enabled: true }
    const after = JSON.parse((await send(port, '/api/test', { method: 'POST', body: { category: 'url', url: 'https://webhook.site/abc?d=1' } })).body)
    expect(after.reason).not.toBe('url-filter-disabled')
    expect(after.urlFilterEnabled).toBe(true)
  })
})

describe('which listeners start opens (#870)', () => {
  it('opens the proxy and the dashboard by default, the gateway only when on', () => {
    expect(listenersToStart(DEFAULT_CONFIG)).toEqual({ proxy: true, dashboard: true, gateway: false })
  })
  it('leaves out a listener switched off', () => {
    const config = structuredClone(DEFAULT_CONFIG) as Config
    config.proxy.enabled = false
    config.dashboard.enabled = false
    config.gateway!.enabled = true
    expect(listenersToStart(config)).toEqual({ proxy: false, dashboard: false, gateway: true })
  })
})

describe('environment overrides (#870)', () => {
  const withEnv = async (env: Record<string, string>) => {
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try { return await loadConfig() } finally { process.env = saved }
  }
  it('reads LLM_FW_PROXY_ENABLED, LLM_FW_DASHBOARD_ENABLED and LLM_FW_DASHBOARD_REQUIRE_AUTH', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-870-env-'))
    try {
      const c = await withEnv({ LLM_FW_DIR: dir, LLM_FW_PROXY_ENABLED: 'false', LLM_FW_DASHBOARD_ENABLED: 'false', LLM_FW_DASHBOARD_REQUIRE_AUTH: 'true' })
      expect(c.proxy.enabled).toBe(false)
      expect(c.dashboard.enabled).toBe(false)
      expect(c.dashboard.requireAuth).toBe(true)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
