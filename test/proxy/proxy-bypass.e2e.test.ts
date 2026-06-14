import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { CertFactory } from '../../src/proxy/certs.js'

// Send a CONNECT and resolve with the CONNECT-level HTTP status code.
async function sendConnect(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  timeoutMs = 3000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('CONNECT timed out')) }, timeoutMs)
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
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

// FAIL-SAFE: with proxy.bypass=true the firewall must become a transparent tunnel
// — even a host it would normally 403 (here a blocklisted loopback) must be piped
// straight through. This is the lock-out escape hatch, so it gets its own guard.
describe('Proxy fail-safe bypass E2E', { timeout: 15000 }, () => {
  const PROXY_PORT = 18093
  let tempDir: string
  let proxy: ProxyServer
  let eventBus: EventBus
  let upstream: net.Server
  let upstreamPort: number

  const baseProxy = {
    ...DEFAULT_CONFIG.proxy,
    port: PROXY_PORT,
    bypass: true,
    urlFilter: {
      ...DEFAULT_CONFIG.proxy.urlFilter,
      enabled: true,
      // 127.0.0.1 would normally be blocked outright; bypass must override that.
      blocklistDomains: ['127.0.0.1'],
    },
  }
  const config = { ...DEFAULT_CONFIG, proxy: baseProxy }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-bypass-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    new CertFactory().generateCA()

    upstream = net.createServer((sock) => { sock.on('error', () => {}); sock.end() })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as net.AddressInfo).port

    eventBus = new EventBus(config.dashboard)
    proxy = new ProxyServer(config, eventBus)
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    await proxy.stop()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('tunnels a normally-blocklisted host when bypass is on', async () => {
    const status = await sendConnect(PROXY_PORT, '127.0.0.1', upstreamPort)
    expect(status).toBe(200) // Connection Established — NOT 403
  })
})
