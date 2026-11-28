import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Socket } from 'node:net'
import { GatewayServer } from '../../src/gateway/gateway.js'
import { Pipeline } from '../../src/detection/pipeline.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

/**
 * The gateway's upstream connections (#842). Its requests go through Node's
 * global agent, which keeps connections alive by default on every Node the
 * project supports, so a connection is reused for the next request to the same
 * provider. A kept connection the provider closed while it sat idle fails
 * before any byte of the answer: the request goes once more, on a new
 * connection, as the proxy's does (#670), instead of a 502 for a request the
 * provider never answered.
 */

vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body) => ({
  result: { action: 'pass', stage: 'heuristic', score: 0 } as never,
  body,
  withheld: 0,
}))

const TOKEN = 'keepalive-token'
const GATEWAY_PORT = 18277
const UPSTREAM_TIMEOUT_MS = 300

let upstream: http.Server
let upstreamPort = 0
let tempDir: string
/** What the upstream does with the n-th request (1-based) on one connection. */
let onRequest: (nth: number, req: http.IncomingMessage, res: http.ServerResponse) => void = answer
let connections = 0
let requests = 0
const perSocket = new WeakMap<Socket, number>()

function answer(_nth: number, _req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"choices":[{"message":{"content":"ok"}}]}')
}

/** Resolves with the status and body the client saw. */
function request(agent: http.Agent | false = false): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'Summarise the release notes.' }] })
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: GATEWAY_PORT, method: 'POST', path: '/v1/chat/completions', agent,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-llm-fw-key': TOKEN },
    }, (res) => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      res.on('error', () => resolve({ status: -1, text }))
    })
    req.on('error', () => resolve({ status: -1, text: '' }))
    req.end(payload)
  })
}

function config(): Config {
  return {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS },
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    // The cost gates (#912) have their own file; these cases resend one body.
    dos: { ...DEFAULT_CONFIG.dos, enabled: false },
    gateway: {
      enabled: true, port: GATEWAY_PORT, bindHost: '127.0.0.1',
      requireAuth: true, authToken: TOKEN, defaultProvider: 'stand',
      providers: {
        stand: { name: 'Stand', host: '127.0.0.1', port: upstreamPort, protocol: 'http', auth: 'bearer' },
      },
    },
  }
}

/** Start from no kept connections, so each case sees its own. */
function resetUpstream(next: typeof onRequest): void {
  upstream.closeAllConnections()
  connections = 0
  requests = 0
  onRequest = next
}

describe('Gateway upstream keep-alive E2E (#842)', { timeout: 30000 }, () => {
  let gateway: GatewayServer
  let bus: EventBus

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-keepalive-'))
    process.env.LLM_FW_DIR = tempDir
    upstream = http.createServer((req, res) => {
      const nth = (perSocket.get(req.socket) ?? 0) + 1
      perSocket.set(req.socket, nth)
      requests++
      req.resume()
      req.on('end', () => onRequest(nth, req, res))
    })
    upstream.on('connection', () => { connections++ })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as { port: number }).port
    const c = config()
    bus = new EventBus(c.dashboard)
    gateway = new GatewayServer(c, bus)
    await gateway.init()
    gateway.start()
  })

  afterAll(async () => {
    await gateway.stop()
    bus.destroy()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('sends consecutive requests to the same provider on one connection', async () => {
    resetUpstream(answer)
    for (let i = 0; i < 3; i++) {
      const res = await request()
      expect(res.status).toBe(200)
      expect(res.text).toContain('ok')
    }
    expect(requests).toBe(3)
    expect(connections).toBe(1)
  })

  it('sends a request again on a new connection when a kept one dies before answering', async () => {
    // The first request on a connection is answered; the next one on it finds
    // the connection closed, as when the provider drops an idle connection
    // just as it is reused.
    resetUpstream((nth, req, res) => {
      if (nth > 1) { req.socket.destroy(); return }
      answer(nth, req, res)
    })
    expect((await request()).status).toBe(200)
    const second = await request()
    expect(second.status).toBe(200)
    expect(second.text).toContain('ok')
    // Once on the kept connection, once more on a new one.
    expect(requests).toBe(3)
    expect(connections).toBe(2)
  })

  it('does not send it again when a new connection dies before answering', async () => {
    resetUpstream((_nth, req) => { req.socket.destroy() })
    const res = await request()
    expect(res.status).toBe(502)
    expect(requests).toBe(1)
  })

  it('does not send it again after a kept connection timed out', async () => {
    // The provider reads the request on the kept connection and never answers:
    // the client gets the 504, and the request must not go out a second time.
    resetUpstream((nth, req, res) => {
      if (nth === 1) answer(nth, req, res)
    })
    // A client that keeps its own connection, as agents do: the gateway's
    // response to it is ended, not destroyed, when the upstream fails.
    const client = new http.Agent({ keepAlive: true })
    try {
      expect((await request(client)).status).toBe(200)
      const res = await request(client)
      expect(res.status).toBe(504)
      await new Promise(resolve => setTimeout(resolve, UPSTREAM_TIMEOUT_MS * 2))
      expect(requests).toBe(2)
    } finally {
      client.destroy()
    }
  })

  it('does not send it again once the answer has started', async () => {
    resetUpstream((nth, req, res) => {
      if (nth === 1) { answer(nth, req, res); return }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n')
      setTimeout(() => req.socket.destroy(), 20)
    })
    expect((await request()).status).toBe(200)
    const cut = await request()
    expect(cut.text).toContain('Hel')
    expect(requests).toBe(2)
    expect(connections).toBe(1)
  })
})
