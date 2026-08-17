import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { CertFactory } from '../../src/proxy/certs.js'

const CRLF = String.fromCharCode(13, 10)

/** Send a plain (non-CONNECT) proxied request and resolve with the raw response. */
async function sendPlainRequest(proxyPort: number, absoluteUri: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('no response — the proxy accepted the request and never answered'))
    }, timeoutMs)
    socket.once('connect', () => {
      const host = new URL(absoluteUri).host
      socket.write(`GET ${absoluteUri} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    let buffer = ''
    socket.on('data', (c) => { buffer += c.toString('utf8') })
    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
    socket.on('close', () => {
      clearTimeout(timer)
      if (buffer) resolve(buffer)
      else reject(new Error('closed without any response'))
    })
  })
}

/**
 * The proxy answers CONNECT and nothing else, so a client that sets HTTP_PROXY
 * and fetches an `http://` URL used to get no response at all: the request was
 * accepted onto a server with no `request` listener and sat there until the
 * client's own timeout fired. Both the README and the standalone startup banner
 * told clients to set HTTP_PROXY, so this was reachable by following the docs.
 *
 * Hanging is the worst available answer — it looks like a network fault rather
 * than a configuration error. These pin a fast, explanatory refusal instead.
 */
describe('Plain HTTP through the proxy E2E', { timeout: 30000 }, () => {
  const PORT = 18131
  let tempDir: string
  let proxy: ProxyServer
  let upstream: net.Server
  let upstreamPort: number

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-plain-http-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    new CertFactory().generateCA()

    upstream = net.createServer((sock) => { sock.on('error', () => {}); sock.end() })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as net.AddressInfo).port
    const config = { ...DEFAULT_CONFIG, proxy: { ...DEFAULT_CONFIG.proxy, port: PORT } }
    proxy = new ProxyServer(config, new EventBus(config.dashboard))
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    await proxy?.stop()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('answers a proxied http:// request instead of hanging', async () => {
    const res = await sendPlainRequest(PORT, 'http://api.openai.com/v1/models')
    expect(res).toMatch(/^HTTP\/1\.1 501 /)
  })

  it('names HTTPS_PROXY in the refusal, so the fix is in the response', async () => {
    const res = await sendPlainRequest(PORT, 'http://api.openai.com/v1/models')
    expect(res).toContain('HTTPS_PROXY')
  })

  it('answers a direct (non-absolute-URI) request too', async () => {
    // A browser pointed at the proxy port, or a health check, sends origin-form.
    const res = await sendPlainRequest(PORT, 'http://127.0.0.1/')
    expect(res).toMatch(/^HTTP\/1\.1 501 /)
  })

  it('still tunnels CONNECT', async () => {
    // The new request handler must not disturb the path that actually works.
    const status = await new Promise<number>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: PORT })
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('CONNECT timed out')) }, 4000)
      socket.once('connect', () => socket.write('CONNECT 127.0.0.1:' + upstreamPort + ' HTTP/1.1' + CRLF + 'Host: 127.0.0.1:' + upstreamPort + CRLF + CRLF))
      let buf = ''
      socket.on('data', (c) => {
        buf += c.toString('binary')
        const sep = buf.indexOf('\r\n\r\n')
        if (sep === -1) return
        clearTimeout(timer)
        socket.destroy()
        resolve(parseInt((buf.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10))
      })
      socket.on('error', (err) => { clearTimeout(timer); reject(err) })
    })
    // CONNECT still reaches handleConnect and opens the tunnel.
    expect(status).toBe(200)
  })
})
