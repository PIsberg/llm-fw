import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { CertFactory } from '../../src/proxy/certs.js'

// ---------------------------------------------------------------------------
// Helper: send CONNECT and return the CONNECT-level HTTP status + body
// ---------------------------------------------------------------------------
async function sendConnect(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  userAgent: string,
  timeoutMs = 3000
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`CONNECT ${targetHost}:${targetPort} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nUser-Agent: ${userAgent}\r\n\r\n`)
    })

    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('binary')
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep !== -1) {
        clearTimeout(timer)
        const headerPart = buffer.slice(0, sep)
        const bodyPart = buffer.slice(sep + 4)
        const statusCode = parseInt((headerPart.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10)
        socket.destroy()
        resolve({ statusCode, body: bodyPart })
      }
    })

    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
    socket.on('close', () => {
      // Proxy may close the socket before we see \r\n\r\n
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep !== -1) {
        clearTimeout(timer)
        const statusCode = parseInt((buffer.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10)
        resolve({ statusCode, body: buffer.slice(sep + 4) })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Helper: query dashboard REST API
// ---------------------------------------------------------------------------
async function queryDashboard(port: number, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve(data) } })
    }).on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// E2E Suite
// ---------------------------------------------------------------------------
describe('Sandbox Telemetry E2E', { timeout: 15000 }, () => {
  const PROXY_PORT = 18092
  const DASHBOARD_PORT = 17742

  let tempDir: string
  let proxy: ProxyServer
  let eventBus: EventBus
  let dashboardServer: http.Server
  let originalEnv: NodeJS.ProcessEnv

  const config = {
    ...DEFAULT_CONFIG,
    proxy: {
      ...DEFAULT_CONFIG.proxy,
      port: PROXY_PORT,
      urlFilter: {
        ...DEFAULT_CONFIG.proxy.urlFilter,
        enabled: true, // We use URL filter to trigger a blocked event easily
        blocklistDomains: ['sandbox-block.example'],
      },
    },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: DASHBOARD_PORT },
  }

  beforeAll(async () => {
    originalEnv = { ...process.env }
    
    // Isolated CA sandbox
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-sandbox-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    new CertFactory().generateCA()

    eventBus = new EventBus(config.dashboard)
    proxy = new ProxyServer(config, eventBus)
    await proxy.init()
    proxy.start()

    const { createDashboardServer } = await import('../../src/dashboard/server.js')
    dashboardServer = createDashboardServer(config, eventBus, (proxy as any).pipeline)
    await new Promise<void>(resolve => dashboardServer.listen(DASHBOARD_PORT, '127.0.0.1', () => resolve()))
  })

  afterAll(async () => {
    process.env = originalEnv
    dashboardServer?.closeAllConnections()
    if (dashboardServer) await new Promise<void>(resolve => dashboardServer.close(() => resolve()))
    if (proxy) await proxy.stop()
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('tags url-filter block events with sandbox metadata when client uses claude-cli UA and explicit override', async () => {
    // Force the environment variable to make it sandboxed = true (1.0 confidence)
    process.env.LLMFW_SANDBOX = 'true'

    // Send a CONNECT request to a blocked domain with a specific user-agent
    const r = await sendConnect(PROXY_PORT, 'sandbox-block.example', 443, 'claude-cli/1.0')
    expect(r.statusCode).toBe(403)
    const json = JSON.parse(r.body)
    expect(json.error).toBe('url blocked')

    // Query dashboard events
    const events = await queryDashboard(DASHBOARD_PORT, '/api/events')
    expect(Array.isArray(events)).toBe(true)

    const urlEvents = (events as any[]).filter(e => e.stage === 'url-filter')
    expect(urlEvents.length).toBeGreaterThanOrEqual(1)

    const ev = urlEvents[0]
    expect(ev.action).toBe('blocked')
    
    // Verify Sandbox metadata is present and correct
    expect(ev.sandboxClient).toBe('claude-code')
    expect(ev.isSandboxed).toBe(true)
    expect(ev.sandboxConfidence).toBe(1.0)
    
    // Clear the env var for other tests if needed
    delete process.env.LLMFW_SANDBOX
  })
})
