import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayServer } from '../../src/gateway/gateway.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { createDashboardServer } from '../../src/dashboard/server.js'
import { ModuleManager } from '../../src/modules/registry.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

const TOKEN = 'gw-modules-test-token'
const GATEWAY_PORT = 18205

interface UpstreamCall { path: string; headers: http.IncomingHttpHeaders; body: string }

function reqHttp(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          ...(payload ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
      },
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

describe('Gateway & Dashboard Modules Live Session', { timeout: 30000 }, () => {
  let tempDir: string
  let gateway: GatewayServer
  let dashboardServer: http.Server
  let dashboardPort = 0
  let upstream: http.Server
  let calls: UpstreamCall[] = []
  let upstreamPort = 0
  let moduleManager: ModuleManager
  let eventBus: EventBus
  let config: Config

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-modules-'))
    process.env.LLM_FW_DIR = tempDir

    // Stand-in upstream echoes received body
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        calls.push({ path: req.url ?? '', headers: req.headers, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, received: body }))
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as { port: number }).port

    config = {
      ...DEFAULT_CONFIG,
      dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
      detection: {
        ...DEFAULT_CONFIG.detection,
        // Disable judge and heavy models in e2e to keep test fast
        judgeEnabled: false,
      },
      modules: {
        enabled: true,
        tokenPruner: { enabled: true },
      },
      gateway: {
        enabled: true,
        port: GATEWAY_PORT,
        bindHost: '127.0.0.1',
        requireAuth: true,
        authToken: TOKEN,
        defaultProvider: 'testprovider',
        providers: {
          testprovider: {
            name: 'Test',
            host: '127.0.0.1',
            port: upstreamPort,
            protocol: 'http',
            auth: 'bearer',
            apiKey: 'test-key',
          },
        },
      },
    }

    eventBus = new EventBus(config.dashboard)
    moduleManager = new ModuleManager(config)

    gateway = new GatewayServer(config, eventBus, undefined, undefined, moduleManager)
    await gateway.init()
    gateway.start()

    dashboardServer = createDashboardServer(config, eventBus, undefined as any, undefined, undefined, moduleManager)
    await new Promise<void>((resolve) => dashboardServer.listen(0, '127.0.0.1', () => resolve()))
    dashboardPort = (dashboardServer.address() as { port: number }).port
  })

  afterAll(async () => {
    await gateway?.stop()
    dashboardServer.closeAllConnections()
    await new Promise<void>((resolve) => dashboardServer.close(() => resolve()))
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('prunes multiline JSON and unnecessary whitespace while strictly preserving code indentation', async () => {
    calls = []
    const rawContent = `Hello    world!   Here is some data:
{
  "user": "alice",
  "action": "login",
  "active": true
}

And some code:
\`\`\`python
def calculate(x):
    if x > 0:
        return x * 2
    return 0
\`\`\`
`
    const requestPayload = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: rawContent }],
    })

    const res = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', requestPayload, {
      'x-llm-fw-key': TOKEN,
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const receivedPayload = JSON.parse(calls[0]!.body)
    const receivedContent: string = receivedPayload.messages[0].content

    // 1. JSON was minified
    expect(receivedContent).toContain('{"user":"alice","action":"login","active":true}')

    // 2. Extra spaces collapsed
    expect(receivedContent).toContain('Hello world! Here is some data:')

    // 3. Python indentation preserved intact
    expect(receivedContent).toContain('def calculate(x):\n    if x > 0:\n        return x * 2\n    return 0')

    // 4. Module stats updated
    const statsRes = await reqHttp(dashboardPort, 'GET', '/api/modules')
    expect(statsRes.status).toBe(200)
    const stats = JSON.parse(statsRes.body)
    expect(stats.totalTokensSaved).toBeGreaterThan(0)
    expect(stats.overallPercentSaved).toBeGreaterThan(0)
    expect(stats.modules).toHaveLength(1)
    expect(stats.modules[0].id).toBe('token-pruner')
    expect(stats.modules[0].enabled).toBe(true)
  })

  it('SSE endpoint /events receives replayed module events', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: dashboardPort,
          method: 'GET',
          path: '/events',
        },
        (res) => {
          let buffer = ''
          res.on('data', (c) => {
            buffer += String(c)
            if (buffer.includes('event: module')) {
              request.destroy()
              resolve(buffer)
            }
          })
          res.on('error', reject)
        },
      )
      request.on('error', (err) => {
        if ((err as any).code !== 'ECONNRESET') reject(err)
      })
      request.end()
    })

    expect(body).toContain('event: module')
    expect(body).toContain('token-pruner')
  })

  it('dynamically disables token pruner via settings without restart', async () => {
    // Disable via settings
    const saveRes = await reqHttp(dashboardPort, 'POST', '/api/settings', JSON.stringify({ tokenPruner: false }))
    expect(saveRes.status).toBe(200)

    calls = []
    const rawContent = `Unpruned    text    with    spaces
{
  "keep": "multiline",
  "formatting": true
}`
    const requestPayload = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: rawContent }],
    })

    const res = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', requestPayload, {
      'x-llm-fw-key': TOKEN,
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const receivedPayload = JSON.parse(calls[0]!.body)
    // Left completely unchanged because token pruner was disabled
    expect(receivedPayload.messages[0].content).toBe(rawContent)
  })

  it('dynamically re-enables token pruner via settings without restart', async () => {
    // Re-enable via settings
    const saveRes = await reqHttp(dashboardPort, 'POST', '/api/settings', JSON.stringify({ tokenPruner: true }))
    expect(saveRes.status).toBe(200)

    calls = []
    const rawContent = `Re-enabled    pruner    with    spaces:
{
  "compact": "me"
}`
    const requestPayload = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: rawContent }],
    })

    const res = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', requestPayload, {
      'x-llm-fw-key': TOKEN,
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const receivedPayload = JSON.parse(calls[0]!.body)
    expect(receivedPayload.messages[0].content).toContain('{"compact":"me"}')
    expect(receivedPayload.messages[0].content).toContain('Re-enabled pruner with spaces:')
  })

  it('observe mode forwards the original body and reports the saving as not applied', async () => {
    config.enforcement = 'observe'
    try {
      calls = []
      const rawContent = 'Observed    request    with    spaces'
      const res = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: rawContent }],
      }), { 'x-llm-fw-key': TOKEN })

      expect(res.status).toBe(200)
      expect(JSON.parse(calls[0]!.body).messages[0].content).toBe(rawContent)
      const last = eventBus.getRecentModuleEvents(1)[0]
      expect(last?.applied).toBe(false)
    } finally {
      config.enforcement = 'enforce'
    }
  })
})
