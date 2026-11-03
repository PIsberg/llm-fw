import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
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

/**
 * The forward proxy's half of #531. An upstream that stops mid-response used to
 * be the gateway's problem only as far as anyone had checked: the proxy rejected
 * forwardRequest, and its handler answers only `if (!headersSent)`, so a client
 * already reading a stream was left waiting for an end that never came.
 *
 * These go through a real CONNECT tunnel and real TLS on both legs, since which
 * end closes what is the whole question.
 */

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')
vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body) => ({
  result: { action: 'pass', stage: 'heuristic', score: 0 } as never,
  body,
  withheld: 0,
}))

const HOST = 'api.anthropic.com'
const PROXY_PORT = 18_293
const UPSTREAM_TIMEOUT_MS = 300
const HUNG_AFTER_MS = 5_000

type Behaviour = 'stall-after-headers' | 'stall-before-headers' | 'reset-after-headers' | 'stall-json-after-headers' | 'stall-handshake'
  | 'close-before-answering' | 'short-plain-body' | 'complete-plain-body' | 'long-generation' | 'slow-buffered-json'
let behaviour: Behaviour = 'stall-after-headers'
let upstreamClosed: Promise<boolean> = Promise.resolve(false)

interface Seen { status: number; outcome: 'closed' | 'hung'; clean: boolean; text: string }

/** What a client sees: the status, what arrived, and whether the connection ever ended. */
function send(caPem: string, stream = true): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => {
      socket.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`)
    })
    socket.on('error', reject)
    socket.once('data', () => {
      let raw = ''
      const payload = JSON.stringify({ model: 'm', stream, messages: [{ role: 'user', content: 'Summarise the release notes.' }] })
      const secure = tls.connect({ socket, servername: HOST, ca: [caPem] }, () => {
        secure.write(`POST /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
      })
      const seen = (outcome: Seen['outcome'], clean: boolean): Seen => ({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0),
        outcome,
        clean,
        text: raw,
      })
      let done = false
      const finish = (s: Seen) => {
        if (done) return
        done = true
        clearTimeout(hung)
        secure.destroy()
        resolve(s)
      }
      const hung = setTimeout(() => finish(seen('hung', false)), HUNG_AFTER_MS)
      secure.on('data', c => {
        raw += c.toString('utf8')
        // A keep-alive response that finished properly: a complete terminal chunk.
        if (raw.endsWith('\r\n0\r\n\r\n')) finish(seen('closed', true))
        const length = /content-length: (\d+)/i.exec(raw)
        const head = raw.indexOf('\r\n\r\n')
        if (length && head !== -1 && Buffer.byteLength(raw.slice(head + 4)) >= Number(length[1])) finish(seen('closed', true))
      })
      secure.on('error', () => finish(seen('closed', false)))
      secure.on('close', () => finish(seen('closed', false)))
    })
  })
}

describe('Proxy: an upstream that stalls or dies (#531, proxy half)', { timeout: 30_000 }, () => {
  const tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-proxy-stall-'))
  const previousDir = process.env.LLM_FW_DIR
  const held = new Set<net.Socket>()
  let upstream: https.Server
  let silent: net.Server
  let proxy: ProxyServer
  let bus: EventBus
  let caPem: string
  let restoreTrust: () => void

  beforeAll(async () => {
    process.env.LLM_FW_DIR = tempDir
    caPem = new CertFactory().generateCA().cert
    const cert = issueUpstreamCert(HOST)
    restoreTrust = trustCA(cert.ca)
    upstream = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      req.resume()
      req.on('end', () => {
        if (behaviour === 'stall-before-headers') return
        if (behaviour === 'close-before-answering') { req.socket.destroy(); return }
        if (behaviour === 'short-plain-body') {
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '1000' })
          res.write('only part of it')
          setTimeout(() => req.socket.destroy(), 30)
          return
        }
        if (behaviour === 'slow-buffered-json') {
          // Keeps the upstream's idle timer alive while the client hears nothing:
          // an inspected JSON body is buffered until it is complete.
          const body = '{"id":"whole","pad":"' + 'x'.repeat(16) + '"}'
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) })
          let at = 0
          const beat = setInterval(() => {
            res.write(body.slice(at, at + 4))
            at += 4
            if (at >= body.length) { clearInterval(beat); res.end() }
          }, UPSTREAM_TIMEOUT_MS / 3)
          return
        }
        if (behaviour === 'complete-plain-body') {
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '5' })
          res.end('whole')
          return
        }
        if (behaviour === 'long-generation') {
          upstreamClosed = new Promise(r => req.socket.once('close', () => r(true)))
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const beat = setInterval(() => res.write('data: {"type":"ping"}\n\n'), 20)
          req.socket.once('close', () => clearInterval(beat))
          return
        }
        if (behaviour === 'stall-json-after-headers') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' })
          res.write('{"id":"partial"')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"type":"content_block_delta","delta":{"text":"Hel"}}\n\n')
        // ...and then nothing, or a connection that dies mid-stream.
        if (behaviour === 'reset-after-headers') setTimeout(() => req.socket.destroy(), 30)
      })
    })
    upstream.on('connection', s => held.add(s))
    upstream.on('secureConnection', s => held.add(s as unknown as net.Socket))
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    const upstreamPort = (upstream.address() as { port: number }).port

    // Accepts TCP and then says nothing, so no TLS handshake ever finishes.
    silent = net.createServer(s => { held.add(s); s.on('error', () => {}) })
    await new Promise<void>(r => silent.listen(0, '127.0.0.1', () => r()))
    const silentPort = (silent.address() as { port: number }).port

    // The target's port comes from CONNECT, so point the proxy's dial at the mock.
    const realConnect = tls.connect
    vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions, cb?: () => void) => {
      if (options.socket) return realConnect(options, cb)
      return realConnect({ ...options, port: behaviour === 'stall-handshake' ? silentPort : upstreamPort }, cb)
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
    for (const s of held) s.destroy()
    upstream.closeAllConnections()
    await new Promise<void>(r => upstream.close(() => r()))
    await new Promise<void>(r => silent.close(() => r()))
    if (previousDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = previousDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('cuts the client when the upstream stalls mid-stream', async () => {
    behaviour = 'stall-after-headers'
    const seen = await send(caPem)
    expect(seen.status).toBe(200)
    expect(seen.text).toContain('Hel')
    expect(seen.outcome).toBe('closed')
    // A clean end would tell the client a truncated stream was complete.
    expect(seen.clean).toBe(false)
  })

  it('cuts the client when the upstream connection dies mid-stream', async () => {
    behaviour = 'reset-after-headers'
    const seen = await send(caPem)
    expect(seen.status).toBe(200)
    expect(seen.text).toContain('Hel')
    expect(seen.outcome).toBe('closed')
    expect(seen.clean).toBe(false)
  })

  it('answers the client when a JSON body stalls part way', async () => {
    behaviour = 'stall-json-after-headers'
    const seen = await send(caPem, false)
    expect(seen.outcome).toBe('closed')
    // Nothing was forwarded yet, so there is still a status to answer with.
    expect(seen.status).toBeGreaterThanOrEqual(500)
  })

  it('answers 502 when the upstream closes without answering, not an empty 200', async () => {
    behaviour = 'close-before-answering'
    const seen = await send(caPem)
    expect(seen.outcome).toBe('closed')
    expect(seen.status).toBe(502)
  })

  it('cuts the client when a plain body ends short of its Content-Length', async () => {
    behaviour = 'short-plain-body'
    const seen = await send(caPem)
    expect(seen.status).toBe(200)
    expect(seen.outcome).toBe('closed')
    expect(seen.clean).toBe(false)
  })

  it('still delivers a complete plain body cleanly', async () => {
    behaviour = 'complete-plain-body'
    const seen = await send(caPem)
    expect(seen.status).toBe(200)
    expect(seen.clean).toBe(true)
    expect(seen.text).toContain('whole')
  })

  // The provider bills for every token it goes on generating for nobody.
  it('closes the upstream when the client goes away', async () => {
    behaviour = 'long-generation'
    upstreamClosed = new Promise(() => {})
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => {
        socket.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`)
      })
      socket.on('error', () => {})
      socket.once('data', () => {
        const payload = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'Write a long essay.' }] })
        const secure = tls.connect({ socket, servername: HOST, ca: [caPem] }, () => {
          secure.write(`POST /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
        })
        secure.on('error', () => {})
        secure.once('data', () => { secure.destroy(); socket.destroy(); resolve() })
        setTimeout(() => reject(new Error('no first bytes')), 4000).unref()
      })
    })
    const closed = await Promise.race([upstreamClosed, new Promise<boolean>(r => setTimeout(() => r(false), 3000))])
    expect(closed).toBe(true)
  })

  it('answers 504 to a realtime upgrade the upstream never finishes', async () => {
    behaviour = 'stall-handshake'
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => {
        socket.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`)
      })
      socket.on('error', reject)
      socket.once('data', () => {
        const secure = tls.connect({ socket, servername: HOST, ca: [caPem] }, () => {
          secure.write(`GET /v1/realtime?model=m HTTP/1.1\r\nHost: ${HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`)
        })
        let raw = ''
        const hung = setTimeout(() => { secure.destroy(); resolve('hung') }, HUNG_AFTER_MS)
        secure.on('data', c => { raw += c.toString('utf8') })
        secure.on('error', () => {})
        secure.on('close', () => { clearTimeout(hung); resolve(raw) })
      })
    })
    expect(answer).toMatch(/^HTTP\/1\.1 504/)
  })

  // Silence from the client: nothing is waiting on it, but the socket and any
  // body buffered so far stayed held for ever.
  const closesWithin = (socket: net.Socket | tls.TLSSocket): Promise<boolean> => new Promise(resolve => {
    const hung = setTimeout(() => { socket.destroy(); resolve(false) }, HUNG_AFTER_MS)
    socket.on('error', () => {})
    socket.on('close', () => { clearTimeout(hung); resolve(true) })
  })
  const tunnel = (): Promise<net.Socket> => new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => {
      socket.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`)
    })
    socket.on('error', reject)
    socket.once('data', () => resolve(socket))
  })

  it('closes a client that goes silent before the TLS handshake', async () => {
    expect(await closesWithin(await tunnel())).toBe(true)
  })

  it('closes a client that goes silent part way through its headers', async () => {
    const socket = await tunnel()
    const secure = tls.connect({ socket, servername: HOST, ca: [caPem] }, () => {
      secure.write(`POST /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\n`)
    })
    expect(await closesWithin(secure)).toBe(true)
  })

  it('closes a client that goes silent part way through its body', async () => {
    const socket = await tunnel()
    const secure = tls.connect({ socket, servername: HOST, ca: [caPem] }, () => {
      secure.write(`POST /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"model":`)
    })
    expect(await closesWithin(secure)).toBe(true)
  })

  // The guard on those: a client waiting for a slow reply is silent as well, and
  // a long non-streaming generation is the normal case.
  it('does not close a client that is only waiting for its answer', async () => {
    behaviour = 'slow-buffered-json'
    const seen = await send(caPem, false)
    expect(seen.status).toBe(200)
    expect(seen.clean).toBe(true)
    expect(seen.text).toContain('whole')
  })

  it('still answers when the upstream stalls before any headers', async () => {
    behaviour = 'stall-before-headers'
    const seen = await send(caPem)
    expect(seen.outcome).toBe('closed')
    expect(seen.status).toBeGreaterThanOrEqual(500)
  })

  it('answers when the upstream accepts TCP and never finishes the TLS handshake', async () => {
    behaviour = 'stall-handshake'
    const seen = await send(caPem)
    expect(seen.outcome).toBe('closed')
    expect(seen.status).toBeGreaterThanOrEqual(500)
  })
})
