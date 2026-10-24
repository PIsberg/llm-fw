import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDashboardServer } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

// GHSA-c725-vwcm-h8rr. A page that rebinds its own domain to 127.0.0.1 is
// same-origin with itself, so its requests carry `Host` and `Origin` for the
// attacker's domain and still arrive from loopback. The dashboard trusted
// loopback without looking at `Host`, so any website could read events and
// change settings on a default install. Loopback trust now needs a `Host`
// that names loopback; anything else must present the token.
describe('dashboard: loopback trust needs a loopback Host', () => {
  const TOKEN = 'dash-token-rebind'
  let tempDir: string
  let server: http.Server
  let config: Config
  let port = 0

  const send = (path: string, opts: { host?: string; method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) }
      if (opts.host !== undefined) headers.Host = opts.host
      if (opts.body) headers['Content-Type'] = 'application/json'
      const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, setHost: opts.host === undefined }, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      })
      req.on('error', reject)
      req.end(opts.body)
    })

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-host-rebinding-'))
    process.env.LLM_FW_DIR = tempDir
    config = structuredClone(DEFAULT_CONFIG) as Config
    config.dashboard.authToken = TOKEN
    server = createDashboardServer(config, new EventBus(config.dashboard), undefined as any)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it.each(['127.0.0.1', 'localhost', '[::1]', 'llm-fw.localhost', '127.0.0.2'])('trusts a loopback caller whose Host is %s', async (name) => {
    expect((await send('/api/settings', { host: `${name}:${port}` })).status).toBe(200)
  })

  it('trusts a loopback caller that sends no Host at all (not a browser)', async () => {
    expect((await send('/api/settings', { host: '' })).status).toBe(200)
  })

  it('refuses a rebound read: loopback caller, foreign Host', async () => {
    const res = await send('/api/events', { host: `evil.example:${port}`, headers: { Origin: `http://evil.example:${port}` } })
    expect(res.status).toBe(401)
  })

  it('refuses a rebound settings change and leaves the setting alone', async () => {
    const before = config.dlp.enabled
    const res = await send('/api/settings', {
      host: `evil.example:${port}`, method: 'POST', body: JSON.stringify({ dlp: !before }),
      headers: { Origin: `http://evil.example:${port}` },
    })
    expect(res.status).toBe(401)
    expect(config.dlp.enabled).toBe(before)
  })

  it('still admits a foreign Host that presents the token (a reverse proxy on this host)', async () => {
    const res = await send('/api/settings', { host: 'llmfw.example.com', headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(200)
  })

  it('still serves the CA to anyone', async () => {
    expect((await send('/ca.crt', { host: `evil.example:${port}` })).status).not.toBe(401)
  })
})
