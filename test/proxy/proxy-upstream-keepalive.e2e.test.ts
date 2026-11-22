import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import net from 'node:net'
import tls from 'node:tls'
import https from 'node:https'
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
import type { Config } from '../../src/types.js'

/**
 * #670: with proxy.upstreamKeepAlive on, the upstream leg reuses one TLS
 * connection per provider host instead of paying TCP and TLS setup (about
 * 50 ms to the providers, measured 2026-11-07) on every request. Off, the
 * default, every request still opens its own connection and sends
 * Connection: close.
 *
 * What must not change with reuse: every response is delivered whole and
 * only once, a truncated one still cuts the client, and a connection the
 * provider closed while idle costs a fresh one, not a failed request.
 */

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')
vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body) => ({
  result: { action: 'pass', stage: 'heuristic', score: 0 } as never,
  body,
  withheld: 0,
}))

const HOST = 'api.anthropic.com'
const PROXY_PORT = 18_297

type Answer = 'json' | 'sse' | 'json-then-close' | 'sse-reset' | 'no-framing' | 'drop-on-reuse'
let answer: Answer = 'json'
let connections = 0
const connectionHeaders: string[] = []
const served = new WeakSet<object>()
const requestsSeen: string[] = []

interface Seen { status: number; clean: boolean; body: string; head: string }

/** One request through its own CONNECT tunnel; the body once the response is complete. */
function send(caPem: string, n: number): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => {
      socket.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`)
    })
    socket.on('error', reject)
    socket.once('data', () => {
      let raw = ''
      const payload = JSON.stringify({ model: 'm', stream: answer.startsWith('sse'), messages: [{ role: 'user', content: `Request ${n}` }] })
      const secure = tls.connect({ socket, servername: HOST, ca: [caPem] }, () => {
        secure.write(`POST /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
      })
      let done = false
      const finish = (clean: boolean) => {
        if (done) return
        done = true
        clearTimeout(hung)
        secure.destroy()
        const head = raw.indexOf('\r\n\r\n')
        resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0), clean, body: head === -1 ? '' : raw.slice(head + 4), head: head === -1 ? raw : raw.slice(0, head) })
      }
      const hung = setTimeout(() => finish(false), 5_000)
      secure.on('data', c => {
        raw += c.toString('utf8')
        if (raw.endsWith('\r\n0\r\n\r\n')) finish(true)
        const length = /content-length: (\d+)/i.exec(raw)
        const head = raw.indexOf('\r\n\r\n')
        if (length && head !== -1 && Buffer.byteLength(raw.slice(head + 4)) >= Number(length[1])) finish(true)
      })
      secure.on('error', () => finish(false))
      secure.on('close', () => finish(false))
    })
  })
}

describe('Proxy: upstream keep-alive (#670)', { timeout: 30_000 }, () => {
  const tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-proxy-keepalive-'))
  const previousDir = process.env.LLM_FW_DIR
  const held = new Set<net.Socket>()
  let upstream: https.Server
  let proxy: ProxyServer
  let bus: EventBus
  let config: Config
  let caPem: string
  let restoreTrust: () => void

  beforeAll(async () => {
    process.env.LLM_FW_DIR = tempDir
    caPem = new CertFactory().generateCA().cert
    const cert = issueUpstreamCert(HOST)
    restoreTrust = trustCA(cert.ca)
    upstream = https.createServer({ key: cert.key, cert: cert.cert, keepAliveTimeout: 10_000 }, (req, res) => {
      connectionHeaders.push(String(req.headers.connection ?? ''))
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const n = /Request (\d+)/.exec(body)?.[1] ?? '?'
        requestsSeen.push(n)
        // A kept connection that dies before answering, as one the provider
        // closed at the moment the proxy took it from the pool.
        if (answer === 'drop-on-reuse' && served.has(req.socket)) { req.socket.destroy(); return }
        served.add(req.socket)
        if (answer === 'json' || answer === 'json-then-close' || answer === 'drop-on-reuse') {
          const json = JSON.stringify({ id: `msg_${n}`, content: [{ type: 'text', text: `answer ${n}` }] })
          const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(json)) }
          if (answer === 'json-then-close') headers.Connection = 'close'
          res.writeHead(200, headers)
          res.end(json)
          return
        }
        if (answer === 'no-framing') {
          // HTTP/1.0-style: no Content-Length, no chunking, the end is the close.
          req.socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nplain ${n}`)
          req.socket.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: {"type":"content_block_delta","delta":{"text":"answer ${n}"}}\n\n`)
        if (answer === 'sse-reset') { setTimeout(() => req.socket.destroy(), 30); return }
        res.end('data: {"type":"message_stop"}\n\n')
      })
    })
    upstream.on('secureConnection', s => { connections++; held.add(s as unknown as net.Socket) })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    const upstreamPort = (upstream.address() as { port: number }).port

    const realConnect = tls.connect
    vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions, cb?: () => void) => {
      if (options.socket) return realConnect(options, cb)
      return realConnect({ ...options, port: upstreamPort }, cb)
    }) as typeof tls.connect)

    config = structuredClone(DEFAULT_CONFIG)
    config.proxy.port = PROXY_PORT
    config.targets = [HOST]
    config.dlp = { ...config.dlp, enabled: false }
    config.dos = { ...config.dos, loopDetectionEnabled: false }
    bus = new EventBus(config.dashboard)
    proxy = new ProxyServer(config, bus)
    proxy.start()
    await new Promise(r => setTimeout(r, 50))
  })

  beforeEach(() => {
    // Nothing pooled carries over: each case starts from no open connection.
    for (const s of held) s.destroy()
    held.clear()
    connections = 0
    connectionHeaders.length = 0
    requestsSeen.length = 0
    answer = 'json'
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    restoreTrust()
    await proxy.stop()
    bus.destroy()
    for (const s of held) s.destroy()
    upstream.closeAllConnections()
    await new Promise<void>(r => upstream.close(() => r()))
    if (previousDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = previousDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('is off by default: a connection per request, each sent Connection: close', async () => {
    expect(DEFAULT_CONFIG.proxy.upstreamKeepAlive).toBe(false)
    config.proxy.upstreamKeepAlive = false
    for (const n of [1, 2, 3]) {
      const seen = await send(caPem, n)
      expect(seen).toMatchObject({ status: 200, clean: true })
      expect(seen.body).toContain(`answer ${n}`)
    }
    expect(connections).toBe(3)
    expect(connectionHeaders).toEqual(['close', 'close', 'close'])
  })

  it('on, reuses one connection for JSON and streamed responses, each delivered whole and to its own request', async () => {
    config.proxy.upstreamKeepAlive = true
    const bodies: string[] = []
    for (const [n, kind] of [[1, 'json'], [2, 'sse'], [3, 'json'], [4, 'sse']] as const) {
      answer = kind
      const seen = await send(caPem, n)
      expect(seen).toMatchObject({ status: 200, clean: true })
      bodies.push(seen.body)
    }
    expect(connections).toBe(1)
    expect(connectionHeaders).toEqual(['keep-alive', 'keep-alive', 'keep-alive', 'keep-alive'])
    bodies.forEach((b, i) => {
      expect(b).toContain(`answer ${i + 1}`)
      for (const other of [1, 2, 3, 4].filter(n => n !== i + 1)) expect(b).not.toContain(`answer ${other}`)
    })
  })

  it('on, tells the client what it was told before: Connection: close, and nothing of the provider\'s keep-alive', async () => {
    // Connection and Keep-Alive are hop-by-hop. The provider's say how long it
    // keeps its connection to the proxy; passed on, they kept the client's
    // tunnel open after a request that asked to close it (5 s per request in
    // the e2e suite).
    for (const on of [false, true]) {
      config.proxy.upstreamKeepAlive = on
      for (const kind of ['json', 'sse'] as const) {
        answer = kind
        const seen = await send(caPem, 1)
        expect(seen.head, `keep-alive ${on}, ${kind}`).toMatch(/^connection: close$/im)
        expect(seen.head).not.toMatch(/^keep-alive:/im)
      }
    }
  })

  it('on, opens a new connection after the provider answers Connection: close', async () => {
    config.proxy.upstreamKeepAlive = true
    answer = 'json-then-close'
    expect((await send(caPem, 1)).body).toContain('answer 1')
    answer = 'json'
    expect((await send(caPem, 2)).body).toContain('answer 2')
    expect(connections).toBe(2)
  })

  it('on, takes a fresh connection when the provider closed the pooled one while it sat idle', async () => {
    config.proxy.upstreamKeepAlive = true
    expect((await send(caPem, 1)).body).toContain('answer 1')
    // The provider ends its idle connection, as one does after its keep-alive timeout.
    for (const s of held) s.destroy()
    await new Promise(r => setTimeout(r, 50))
    const seen = await send(caPem, 2)
    expect(seen).toMatchObject({ status: 200, clean: true })
    expect(seen.body).toContain('answer 2')
    expect(connections).toBe(2)
  })

  it('on, sends the request again on a new connection when a kept one dies before answering', async () => {
    config.proxy.upstreamKeepAlive = true
    answer = 'drop-on-reuse'
    expect((await send(caPem, 1)).body).toContain('answer 1')
    const seen = await send(caPem, 2)
    expect(seen).toMatchObject({ status: 200, clean: true })
    expect(seen.body).toContain('answer 2')
    expect(connections).toBe(2)
    // The provider read request 2 on the dead connection too: the one retry
    // can repeat a request it dropped without a byte of answer.
    expect(requestsSeen).toEqual(['1', '2', '2'])
  })

  it('on, still cuts the client when the stream dies part way, and does not reuse that connection', async () => {
    config.proxy.upstreamKeepAlive = true
    answer = 'sse-reset'
    const seen = await send(caPem, 1)
    expect(seen.body).toContain('answer 1')
    expect(seen.clean).toBe(false)
    answer = 'json'
    expect((await send(caPem, 2)).body).toContain('answer 2')
    expect(connections).toBe(2)
  })

  it('on, reads a response with no framing to its close, as before', async () => {
    config.proxy.upstreamKeepAlive = true
    answer = 'no-framing'
    const seen = await send(caPem, 1)
    expect(seen.body).toContain('plain 1')
    answer = 'json'
    expect((await send(caPem, 2)).body).toContain('answer 2')
    expect(connections).toBe(2)
  })
})
