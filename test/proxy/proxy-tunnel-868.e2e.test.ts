import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import tls from 'node:tls'
import https from 'node:https'
import fs from 'node:fs'
import { duplexPair } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { UpstreamResolver } from '../../src/proxy/upstream.js'
import { CertFactory } from '../../src/proxy/certs.js'
import { issueUpstreamCert, trustCA } from './lib/tls-trust.js'
import type { Config } from '../../src/types.js'

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

// #868: the CONNECT tunnel and the request the proxy writes upstream.
const PROXY_PORT = 18301
const BLACKHOLE = '192.0.2.99'

describe('CONNECT tunnels and forwarded requests (#868)', { timeout: 30_000 }, () => {
  let tempDir: string
  let proxyCa: string
  let restoreTrust: () => void
  let proxy: ProxyServer
  let echo: net.Server
  let echoPort = 0
  const echoClosed: Array<Promise<void>> = []
  let upstream: https.Server
  let upstreamPort = 0
  const upstreamHeaders: Array<Record<string, string | string[] | undefined>> = []
  const realCreateConnection = net.createConnection

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-tunnel-868-'))
    process.env.LLM_FW_DIR = tempDir
    proxyCa = new CertFactory().generateCA().cert
    const upstreamCert = issueUpstreamCert('api.anthropic.com')
    restoreTrust = trustCA(upstreamCert.ca)

    // Echoes, and never ends its side on its own: a half-open client must not
    // keep it. After the FIN it keeps writing, so a proxy that has let go of
    // the connection resets it and the socket closes; one that still holds it
    // half-open takes the bytes and it never does.
    echo = net.createServer({ allowHalfOpen: true }, (s) => {
      echoClosed.push(new Promise(r => s.on('close', () => r())))
      s.on('data', d => s.write(d))
      s.on('end', () => {
        const t = setInterval(() => { if (!s.destroyed) s.write('.') }, 100)
        s.on('close', () => clearInterval(t))
      })
      s.on('error', () => {})
    })
    await new Promise<void>(r => echo.listen(0, '127.0.0.1', () => r()))
    echoPort = (echo.address() as net.AddressInfo).port

    upstream = https.createServer({ key: upstreamCert.key, cert: upstreamCert.cert }, (req, res) => {
      upstreamHeaders.push(req.headers)
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}') })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (upstream.address() as net.AddressInfo).port

    // A destination that never accepts the connection.
    vi.spyOn(net, 'createConnection').mockImplementation(((...args: Parameters<typeof net.createConnection>) => {
      const opts = args[0] as net.NetConnectOpts & { host?: string }
      if (typeof opts === 'object' && opts.host === BLACKHOLE) return new net.Socket()
      return (realCreateConnection as (...a: unknown[]) => net.Socket)(...args)
    }) as typeof net.createConnection)

    const config: Config = {
      ...DEFAULT_CONFIG,
      proxy: { ...DEFAULT_CONFIG.proxy, port: PROXY_PORT, upstreamTimeoutMs: 800 },
      detection: { ...DEFAULT_CONFIG.detection, judgeEnabled: false },
    }
    proxy = new ProxyServer(config, new EventBus(config.dashboard))
    await proxy.init()
    proxy.start()
  }, 60_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    await proxy?.stop()
    await new Promise<void>(r => echo.close(() => r()))
    await new Promise<void>(r => upstream.close(() => r()))
    restoreTrust?.()
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** Opens a socket to the proxy and writes `first` as one write; resolves with all it reads until `until` holds or it closes. */
  function talk(first: Buffer | string, until: (got: string) => boolean): Promise<{ got: string; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
      const socket = realCreateConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => socket.write(first))
      let got = ''
      const done = () => resolve({ got, socket })
      socket.on('data', d => { got += d.toString('latin1'); if (until(got)) done() })
      socket.on('close', done)
      socket.on('error', reject)
    })
  }

  it('forwards bytes the client sent along with CONNECT on a direct tunnel', async () => {
    const { got, socket } = await talk(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\nPING-PIPELINED`, g => g.includes('PING-PIPELINED'))
    expect(got).toContain('200 Connection Established')
    expect(got).toContain('PING-PIPELINED')
    socket.destroy()
  })

  it('closes the destination when the client half-closes the tunnel', async () => {
    const before = echoClosed.length
    const { socket } = await talk(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`, g => g.includes('\r\n\r\n'))
    await vi.waitFor(() => expect(echoClosed.length).toBe(before + 1))
    socket.end()
    await Promise.race([echoClosed[before]!, new Promise((_, rej) => setTimeout(() => rej(new Error('destination still open 2 s after the client ended')), 2000))])
    socket.destroy()
  })

  it('answers 504 when the destination does not accept within upstreamTimeoutMs', async () => {
    const started = Date.now()
    const { got } = await talk(`CONNECT ${BLACKHOLE}:443 HTTP/1.1\r\nHost: ${BLACKHOLE}:443\r\n\r\n`, g => g.includes('\r\n\r\n'))
    expect(got).toMatch(/^HTTP\/1\.1 504/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('completes the TLS handshake when the ClientHello arrives with the CONNECT', async () => {
    const [mine, theirs] = duplexPair()
    const client = tls.connect({ socket: mine, servername: 'api.anthropic.com', ca: proxyCa })
    const hello = await new Promise<Buffer>(r => theirs.once('data', r))
    const raw = realCreateConnection({ host: '127.0.0.1', port: PROXY_PORT })
    await new Promise<void>(r => raw.once('connect', () => r()))
    raw.write(Buffer.concat([Buffer.from(`CONNECT api.anthropic.com:${upstreamPort} HTTP/1.1\r\nHost: api.anthropic.com:${upstreamPort}\r\n\r\n`), hello]))
    let head = Buffer.alloc(0)
    raw.on('data', (d: Buffer) => {
      if (head !== null) {
        head = Buffer.concat([head, d])
        const end = head.indexOf('\r\n\r\n')
        if (end < 0) return
        const rest = head.subarray(end + 4)
        head = null as unknown as Buffer
        if (rest.length) theirs.write(rest)
        return
      }
      theirs.write(d)
    })
    theirs.on('data', (d: Buffer) => raw.write(d))
    await new Promise<void>((resolve, reject) => {
      client.once('secureConnect', () => resolve())
      client.once('error', reject)
      setTimeout(() => reject(new Error('no TLS handshake: the pipelined ClientHello was dropped')), 5000)
    })
    client.destroy(); raw.destroy()
  })

  it('sends no Content-Length on a GET without a body, and one on a POST', async () => {
    const request = (method: string, body: string) => new Promise<void>((resolve, reject) => {
      const req = https.request({
        host: 'api.anthropic.com', port: upstreamPort, method, path: '/v1/models', ca: proxyCa,
        agent: new (class extends https.Agent {
          override createConnection(_o: unknown, cb: (err: Error | null, s?: net.Socket) => void): undefined {
            const raw = realCreateConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => raw.write(`CONNECT api.anthropic.com:${upstreamPort} HTTP/1.1\r\nHost: api.anthropic.com:${upstreamPort}\r\n\r\n`))
            raw.once('data', () => cb(null, tls.connect({ socket: raw, servername: 'api.anthropic.com', ca: proxyCa }) as unknown as net.Socket))
            raw.once('error', (e) => cb(e))
            return undefined
          }
        })(),
      }, (res) => { res.resume(); res.on('end', () => resolve()) })
      req.on('error', reject)
      req.end(body)
    })
    upstreamHeaders.length = 0
    await request('GET', '')
    await request('POST', '{"x":1}')
    expect(upstreamHeaders[0]!['content-length']).toBeUndefined()
    expect(upstreamHeaders[1]!['content-length']).toBe('7')
  })
})
