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
  timeoutMs = 3000
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`CONNECT ${targetHost}:${targetPort} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
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
      // Proxy may close the socket before we see \r\n\r\n (e.g., 403 sent + destroyed)
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
describe('URL Filter E2E', { timeout: 15000 }, () => {
  const PROXY_PORT = 18090
  const DASHBOARD_PORT = 17741

  let tempDir: string
  let proxy: ProxyServer
  let eventBus: EventBus
  let safeUpstream: net.Server
  let safeUpstreamPort: number
  let dashboardServer: http.Server

  const config = {
    ...DEFAULT_CONFIG,
    proxy: {
      ...DEFAULT_CONFIG.proxy,
      port: PROXY_PORT,
      urlFilter: {
        ...DEFAULT_CONFIG.proxy.urlFilter,
        enabled: true,
        blocklistDomains: ['custom-blocked.example'],
      },
    },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: DASHBOARD_PORT },
  }

  beforeAll(async () => {
    // Isolated CA sandbox
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-url-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    new CertFactory().generateCA()

    // Minimal TCP server that accepts connections and closes them cleanly —
    // used as the upstream for the "allowed domain passes through" case.
    safeUpstream = net.createServer((sock) => { sock.on('error', () => {}); sock.end() })
    await new Promise<void>(resolve => safeUpstream.listen(0, '127.0.0.1', () => resolve()))
    safeUpstreamPort = (safeUpstream.address() as net.AddressInfo).port

    eventBus = new EventBus(config.dashboard)
    proxy = new ProxyServer(config, eventBus)
    await proxy.init()
    proxy.start()

    // Dashboard needed for event log assertions
    const { createDashboardServer } = await import('../../src/dashboard/server.js')
    dashboardServer = createDashboardServer(config, eventBus, (proxy as any).pipeline)
    await new Promise<void>(resolve => dashboardServer.listen(DASHBOARD_PORT, '127.0.0.1', () => resolve()))
  })

  afterAll(async () => {
    dashboardServer.closeAllConnections()
    await new Promise<void>(resolve => dashboardServer.close(() => resolve()))
    await proxy.stop()
    await new Promise<void>(resolve => safeUpstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  // ── Blocking cases ────────────────────────────────────────────────────────

  it('blocks CONNECT to a known exfil domain (webhook.site)', async () => {
    const r = await sendConnect(PROXY_PORT, 'webhook.site', 443)
    expect(r.statusCode).toBe(403)
    const json = JSON.parse(r.body)
    expect(json.error).toBe('url blocked')
    expect(json.reason).toBe('known-exfil-domain')
  })

  it('blocks CONNECT to ngrok tunnel domain', async () => {
    const r = await sendConnect(PROXY_PORT, 'abc123.ngrok-free.app', 443)
    expect(r.statusCode).toBe(403)
    const json = JSON.parse(r.body)
    expect(json.error).toBe('url blocked')
    expect(json.reason).toBe('known-exfil-domain')
  })

  it('blocks CONNECT to a high-entropy subdomain (DNS tunneling)', async () => {
    // 33 unique chars in 33-char label → entropy ≈ 5.0 bits, above 4.8 threshold
    const r = await sendConnect(PROXY_PORT, 'zQ7mK2pX9vN4wL8tG5bY1jH6rC3sF0aD.malicious-c2.com', 443)
    expect(r.statusCode).toBe(403)
    const json = JSON.parse(r.body)
    expect(json.error).toBe('url blocked')
    expect(json.reason).toMatch('high-entropy-subdomain')
  })

  it('blocks CONNECT to a user-configured blocklist domain', async () => {
    const r = await sendConnect(PROXY_PORT, 'custom-blocked.example', 443)
    expect(r.statusCode).toBe(403)
    const json = JSON.parse(r.body)
    expect(json.error).toBe('url blocked')
    expect(json.reason).toBe('domain-blocklisted')
  })

  it('blocks CONNECT to a subdomain of a user-configured blocklist domain', async () => {
    const r = await sendConnect(PROXY_PORT, 'exfil.custom-blocked.example', 443)
    expect(r.statusCode).toBe(403)
    const json = JSON.parse(r.body)
    expect(json.reason).toBe('domain-blocklisted')
  })

  // ── Pass-through case ─────────────────────────────────────────────────────

  it('allows CONNECT to a safe non-LLM domain through the URL filter', async () => {
    // 127.0.0.1 is not on any blocklist; proxy establishes tunnel → 200
    const r = await sendConnect(PROXY_PORT, '127.0.0.1', safeUpstreamPort)
    expect(r.statusCode).toBe(200)
  })

  // ── Dashboard event log ───────────────────────────────────────────────────

  it('emits url-filter BlockEvents for blocked connections', async () => {
    // The preceding test cases already produced block events.
    // Trigger one more with a deterministic target for assertion.
    await sendConnect(PROXY_PORT, 'requestbin.com', 443)

    const events = await queryDashboard(DASHBOARD_PORT, '/api/events')
    expect(Array.isArray(events)).toBe(true)

    const urlEvents = (events as any[]).filter(e => e.stage === 'url-filter')
    expect(urlEvents.length).toBeGreaterThanOrEqual(1)

    // Most recent url-filter event should be for requestbin.com
    const ev = urlEvents[0]
    expect(ev.action).toBe('blocked')
    expect(ev.kind).toBe('url')
    expect(ev.target).toBe('requestbin.com')
    expect(ev.method).toBe('CONNECT')
    expect(ev.urlBlockReason).toBe('known-exfil-domain')
    expect(ev.score).toBe(100)
    expect(ev.id).toBeDefined()
    expect(ev.timestamp).toBeDefined()
  })
})
