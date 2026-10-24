import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayServer } from '../../src/gateway/gateway.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

// GHSA-c725-vwcm-h8rr. A gateway bound to loopback asks no client for a token,
// and with key custody it adds the operator's provider key itself. A web page
// that rebinds its domain to 127.0.0.1 could therefore spend that key and read
// the answers. Loopback trust now needs a `Host` that names loopback.
describe('gateway: loopback trust needs a loopback Host', { timeout: 30000 }, () => {
  const PORT = 18241
  const TOKEN = 'gw-token-rebind'
  let tempDir: string
  let gateway: GatewayServer
  let upstream: http.Server
  let calls = 0

  const post = (host: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'Summarise the release notes for me.' }] })
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST', setHost: false,
      headers: { Host: host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.end(body)
  })

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gateway-rebinding-'))
    process.env.LLM_FW_DIR = tempDir
    upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => { calls++; res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}') })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    const upstreamPort = (upstream.address() as { port: number }).port

    const config: Config = {
      ...DEFAULT_CONFIG,
      dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
      gateway: {
        enabled: true,
        port: PORT,
        bindHost: '127.0.0.1',
        // requireAuth left unset: a loopback bind infers "no token needed",
        // the default single-user case this advisory is about. A token is
        // configured so a caller behind a same-host reverse proxy can use it.
        authToken: TOKEN,
        defaultProvider: 'testprovider',
        providers: {
          testprovider: { name: 'Test', host: '127.0.0.1', port: upstreamPort, protocol: 'http', auth: 'x-api-key', apiKey: 'operator-secret-key' },
        },
      },
    }
    gateway = new GatewayServer(config, new EventBus(config.dashboard))
    await gateway.init()
    gateway.start()
  })

  afterAll(async () => {
    await gateway?.stop()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('serves a loopback caller that names loopback, with no token', async () => {
    calls = 0
    expect(await post(`127.0.0.1:${PORT}`)).toBe(200)
    expect(await post(`localhost:${PORT}`)).toBe(200)
    expect(calls).toBe(2)
  })

  it('refuses a rebound request and never reaches the provider', async () => {
    calls = 0
    expect(await post(`evil.example:${PORT}`, { Origin: `http://evil.example:${PORT}` })).toBe(401)
    expect(calls).toBe(0)
  })

  it('admits a foreign Host that presents the token', async () => {
    calls = 0
    expect(await post('gateway.example.com', { 'x-llm-fw-key': TOKEN })).toBe(200)
    expect(calls).toBe(1)
  })
})
