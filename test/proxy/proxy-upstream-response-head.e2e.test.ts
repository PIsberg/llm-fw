import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { Pipeline } from '../../src/detection/pipeline.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { UpstreamResolver } from '../../src/proxy/upstream.js'
import { CertFactory } from '../../src/proxy/certs.js'
import { issueUpstreamCert, trustCA } from './lib/tls-trust.js'

/**
 * #855: the proxy reads the provider's response head off the socket itself.
 * The upstream here writes raw bytes, so each case is exactly the head a
 * provider, or something in front of one, could send.
 */

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')
vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body) => ({
  result: { action: 'pass', stage: 'heuristic', score: 0 } as never,
  body,
  withheld: 0,
}))

const HOST = 'api.anthropic.com'
const PROXY_PORT = 18_295
const UPSTREAM_TIMEOUT_MS = 4_000
let answer = ''
// When set, upstream connections go to this port, where nothing listens (#866).
let refusePort = 0
// Write the answer and keep the connection open, as a stuck upstream would.
let keepOpen = false

interface Seen { status: number; head: string; body: string; ms: number }

/** One request through the proxy, read to the connection's close. */
function send(caPem: string): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = net.createConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => {
      socket.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`)
    })
    socket.on('error', reject)
    socket.once('data', () => {
      let raw = ''
      const payload = 'x'.repeat(2048)
      const secure = tls.connect({ socket, servername: HOST, ca: [caPem] }, () => {
        secure.write(`POST /v1/files HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: text/plain\r\nExpect: 100-continue\r\nConnection: close\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`)
      })
      const done = (): void => {
        // The proxy's own server answers the client's Expect: 100-continue
        // with an interim 100, as it should; a client reads past it.
        while (/^HTTP\/1\.1 1\d\d /.test(raw) && raw.includes('\r\n\r\n')) raw = raw.slice(raw.indexOf('\r\n\r\n') + 4)
        const sep = raw.indexOf('\r\n\r\n')
        resolve({
          status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0),
          head: sep === -1 ? raw : raw.slice(0, sep),
          body: sep === -1 ? '' : raw.slice(sep + 4),
          ms: Date.now() - started,
        })
      }
      secure.on('data', c => { raw += c.toString('latin1') })
      secure.on('error', done)
      secure.on('close', done)
    })
  })
}

/** The decoded body of a chunked response, or the body as it came. */
function dechunked(body: string): string {
  if (!/^[0-9a-f]+\r\n/i.test(body)) return body
  let out = ''
  let at = 0
  for (;;) {
    const eol = body.indexOf('\r\n', at)
    const size = Number.parseInt(body.slice(at, eol), 16)
    if (!size) return out
    out += body.slice(eol + 2, eol + 2 + size)
    at = eol + 2 + size + 2
  }
}

describe('Proxy: the provider response head (#855)', { timeout: 30_000 }, () => {
  const tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-proxy-head-'))
  const previousDir = process.env.LLM_FW_DIR
  let upstream: tls.Server
  let proxy: ProxyServer
  let bus: EventBus
  let caPem: string
  let restoreTrust: () => void
  let seenRequest = ''

  beforeAll(async () => {
    process.env.LLM_FW_DIR = tempDir
    caPem = new CertFactory().generateCA().cert
    const cert = issueUpstreamCert(HOST)
    restoreTrust = trustCA(cert.ca)
    upstream = tls.createServer({ key: cert.key, cert: cert.cert }, (s) => {
      s.on('error', () => {})
      let req = ''
      s.on('data', (c) => {
        req += c.toString('latin1')
        const sep = req.indexOf('\r\n\r\n')
        const length = Number(/content-length: *(\d+)/i.exec(req)?.[1] ?? 0)
        if (sep === -1 || req.length - sep - 4 < length) return
        seenRequest = req
        if (keepOpen) s.write(answer)
        else s.end(answer)
      })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    const upstreamPort = (upstream.address() as { port: number }).port
    const realConnect = tls.connect
    vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions, cb?: () => void) => {
      if (options.socket) return realConnect(options, cb)
      return realConnect({ ...options, port: refusePort || upstreamPort }, cb)
    }) as typeof tls.connect)

    const config = structuredClone(DEFAULT_CONFIG)
    config.proxy.port = PROXY_PORT
    config.proxy.upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS
    config.targets = [HOST]
    config.dlp = { ...config.dlp, enabled: false }
    config.dos = { ...config.dos, loopDetectionEnabled: false }
    bus = new EventBus(config.dashboard)
    proxy = new ProxyServer(config, bus)
    proxy.start()
    await new Promise(r => setTimeout(r, 50))
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    restoreTrust()
    await proxy.stop()
    bus.destroy()
    await new Promise<void>(r => upstream.close(() => r()))
    if (previousDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = previousDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('does not pass the client\'s Expect: 100-continue on to the provider', async () => {
    answer = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok'
    await send(caPem)
    expect(seenRequest.toLowerCase()).not.toContain('expect:')
  })

  it.each([
    ['100 Continue', 'HTTP/1.1 100 Continue\r\n\r\n'],
    ['103 Early Hints', 'HTTP/1.1 103 Early Hints\r\nLink: </a.css>; rel=preload\r\n\r\n'],
  ])('answers with the final response after an interim %s', async (_label, interim) => {
    answer = `${interim}HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello`
    const seen = await send(caPem)
    expect(seen.status).toBe(200)
    expect(dechunked(seen.body)).toBe('hello')
  })

  it('reads headers written without a space after the colon', async () => {
    answer = 'HTTP/1.1 200 OK\r\nContent-Type:text/plain\r\nTransfer-Encoding:chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'
    const seen = await send(caPem)
    expect(seen.head.toLowerCase()).toContain('content-type: text/plain')
    expect(dechunked(seen.body)).toBe('hello')
  })

  it('passes every Set-Cookie line on', async () => {
    answer = 'HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 2\r\n\r\nok'
    const seen = await send(caPem)
    expect(seen.head).toContain('a=1')
    expect(seen.head).toContain('b=2')
  })

  it('answers an error, and keeps serving, after a malformed status line', async () => {
    answer = 'HTTP/1.1 abc OK\r\nContent-Length: 2\r\n\r\nok'
    const bad = await send(caPem)
    expect(bad.status).toBe(502)
    answer = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'
    expect((await send(caPem)).status).toBe(200)
  })

  it('gives up at once on a head that never ends', async () => {
    answer = `HTTP/1.1 200 OK\r\nX-Pad: ${'a'.repeat(70 * 1024)}\r\n`
    keepOpen = true
    const seen = await send(caPem).finally(() => { keepOpen = false })
    expect(seen.status).toBe(502)
    expect(seen.ms).toBeLessThan(UPSTREAM_TIMEOUT_MS / 2)
  })

  // #866: the resolver kept one address per host. A connection the upstream
  // refuses now reports that address, so the next request goes to another.
  it('reports an address that refuses the connection to the resolver (#866)', async () => {
    const markFailed = vi.spyOn(UpstreamResolver.prototype, 'markFailed')
    const probe = net.createServer()
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()))
    refusePort = (probe.address() as { port: number }).port
    await new Promise<void>(r => probe.close(() => r()))
    try {
      await send(caPem)
    } finally {
      refusePort = 0
    }
    expect(markFailed).toHaveBeenCalledWith(HOST, '127.0.0.1')
  })
})
