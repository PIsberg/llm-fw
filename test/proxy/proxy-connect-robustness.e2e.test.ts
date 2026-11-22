import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { CertFactory } from '../../src/proxy/certs.js'

// #850: one malformed CONNECT, or one client connection that errors, must not
// take the proxy down. Every agent session on the machine goes through it.

async function sendConnect(proxyPort: number, target: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`CONNECT ${target} timed out`)) }, 5000)
    socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    let buffer = ''
    const settle = (): void => {
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep === -1) return
      clearTimeout(timer)
      socket.destroy()
      resolve({ statusCode: Number.parseInt((buffer.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10), body: buffer.slice(sep + 4) })
    }
    socket.on('data', (c) => { buffer += c.toString('latin1'); settle() })
    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
    socket.on('close', () => { settle(); clearTimeout(timer); reject(new Error(`CONNECT ${target}: closed without a response`)) })
  })
}

describe('Proxy CONNECT robustness E2E (#850)', { timeout: 20000 }, () => {
  const PORT = 18291
  let tempDir: string
  let proxy: ProxyServer
  let upstream: net.Server
  let upstreamPort: number

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-connect-robust-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    new CertFactory().generateCA()
    upstream = net.createServer((s) => { s.on('error', () => {}); s.end() })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (upstream.address() as net.AddressInfo).port
    const config = { ...DEFAULT_CONFIG, proxy: { ...DEFAULT_CONFIG.proxy, port: PORT } }
    proxy = new ProxyServer(config, new EventBus(config.dashboard))
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    await proxy?.stop()
    await new Promise<void>(r => upstream.close(() => r()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it.each(['127.0.0.1:99999', '127.0.0.1:65536', '127.0.0.1:-1', '[::1]:70000'])(
    'answers 400 to the port in %s and keeps serving',
    async (target) => {
      // Before the fix net.connect threw ERR_SOCKET_BAD_PORT inside the
      // un-awaited handleConnect: an unhandled rejection, which llm-fw start
      // turns into a process exit.
      const r = await sendConnect(PORT, target)
      expect(r.statusCode).toBe(400)
      expect(JSON.parse(r.body).error).toMatch(/port/)
      expect((await sendConnect(PORT, `127.0.0.1:${upstreamPort}`)).statusCode).toBe(200)
    },
  )

  it('does not throw when a refused client connection reports an error', async () => {
    // A client that resets its connection while the proxy answers a refused
    // CONNECT makes Node emit 'error' on the socket, and an 'error' with no
    // listener is thrown out of the event loop. The refusal paths (URL filter,
    // a bad port, the tunnel guard) wrote to the socket with no listener on
    // it. Raised here deterministically, right after the proxy handled the
    // CONNECT, the way a reset that arrives with the request is delivered.
    const server = (proxy as unknown as { server: net.Server }).server
    let thrown: unknown = null
    const raise = (_req: unknown, socket: net.Socket): void => {
      try { socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })) } catch (err) { thrown = err }
    }
    server.on('connect', raise)
    try {
      expect((await sendConnect(PORT, 'webhook.site:443')).statusCode).toBe(403)
    } finally {
      server.off('connect', raise)
    }
    expect(thrown).toBeNull()
    expect((await sendConnect(PORT, `127.0.0.1:${upstreamPort}`)).statusCode).toBe(200)
  })
})
