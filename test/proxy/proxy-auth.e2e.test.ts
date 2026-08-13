import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { CertFactory } from '../../src/proxy/certs.js'

// Send a CONNECT with optional extra headers; resolve with the CONNECT-level
// HTTP status code.
async function sendConnect(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 3000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('CONNECT timed out')) }, timeoutMs)
    socket.once('connect', () => {
      const extra = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join('')
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${extra}\r\n`)
    })
    let buffer = ''
    const tryResolve = () => {
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep === -1) return false
      clearTimeout(timer)
      const status = parseInt((buffer.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10)
      socket.destroy()
      resolve(status)
      return true
    }
    socket.on('data', (c) => { buffer += c.toString('binary'); tryResolve() })
    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
    socket.on('close', () => { if (!tryResolve()) { clearTimeout(timer); reject(new Error('closed without response')) } })
  })
}

const basic = (token: string) => `Basic ${Buffer.from(`llm-fw:${token}`).toString('base64')}`

// A proxy bound off-host with no credential check is an open forward relay: any
// machine that can reach the port can tunnel arbitrary CONNECT traffic through
// it, including to hosts the firewall never inspects (non-targets are piped
// straight through). These tests pin the credential gate that closes that.
//
// `requireAuth: true` is used instead of a 0.0.0.0 bind so the check applies to
// the loopback client the test itself is — binding the test to a public
// interface would be a worse trade.
describe('Proxy client authentication E2E', { timeout: 30000 }, () => {
  const AUTH_PORT = 18101
  const BYPASS_PORT = 18102
  const OPEN_PORT = 18103
  const TOKEN = 'test-proxy-token'

  let tempDir: string
  let authProxy: ProxyServer
  let bypassProxy: ProxyServer
  let openProxy: ProxyServer
  let upstream: net.Server
  let upstreamPort: number

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-proxy-auth-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    new CertFactory().generateCA()

    upstream = net.createServer((sock) => { sock.on('error', () => {}); sock.end() })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as net.AddressInfo).port

    const start = async (port: number, extra: Record<string, unknown>): Promise<ProxyServer> => {
      const config = {
        ...DEFAULT_CONFIG,
        proxy: { ...DEFAULT_CONFIG.proxy, port, ...extra },
      }
      const server = new ProxyServer(config, new EventBus(config.dashboard))
      await server.init()
      server.start()
      return server
    }

    authProxy = await start(AUTH_PORT, { requireAuth: true, authToken: TOKEN })
    // Fail-safe bypass AND auth: the escape hatch must not double as an
    // anonymous open relay.
    bypassProxy = await start(BYPASS_PORT, { requireAuth: true, authToken: TOKEN, bypass: true })
    // The default single-user install: local bind, no token configured.
    openProxy = await start(OPEN_PORT, {})
  })

  afterAll(async () => {
    await Promise.all([authProxy?.stop(), bypassProxy?.stop(), openProxy?.stop()])
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('refuses an unauthenticated CONNECT with 407', async () => {
    expect(await sendConnect(AUTH_PORT, '127.0.0.1', upstreamPort)).toBe(407)
  })

  it('refuses a wrong credential', async () => {
    const headers = { 'Proxy-Authorization': basic('wrong-token') }
    expect(await sendConnect(AUTH_PORT, '127.0.0.1', upstreamPort, headers)).toBe(407)
  })

  it('accepts a Basic credential carrying the token as the password', async () => {
    const headers = { 'Proxy-Authorization': basic(TOKEN) }
    expect(await sendConnect(AUTH_PORT, '127.0.0.1', upstreamPort, headers)).toBe(200)
  })

  it('accepts a Bearer credential', async () => {
    const headers = { 'Proxy-Authorization': `Bearer ${TOKEN}` }
    expect(await sendConnect(AUTH_PORT, '127.0.0.1', upstreamPort, headers)).toBe(200)
  })

  it('ignores the upstream API key in Authorization', async () => {
    // A client that sends only its provider key must not be admitted by it.
    const headers = { Authorization: `Bearer ${TOKEN}` }
    expect(await sendConnect(AUTH_PORT, '127.0.0.1', upstreamPort, headers)).toBe(407)
  })

  it('still demands a credential when fail-safe bypass is on', async () => {
    expect(await sendConnect(BYPASS_PORT, '127.0.0.1', upstreamPort)).toBe(407)
    const headers = { 'Proxy-Authorization': basic(TOKEN) }
    expect(await sendConnect(BYPASS_PORT, '127.0.0.1', upstreamPort, headers)).toBe(200)
  })

  it('demands nothing on the default local-only install', async () => {
    expect(await sendConnect(OPEN_PORT, '127.0.0.1', upstreamPort)).toBe(200)
  })
})
