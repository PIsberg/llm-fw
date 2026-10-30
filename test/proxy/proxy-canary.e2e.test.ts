import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { UpstreamResolver } from '../../src/proxy/upstream.js'
import { CertFactory } from '../../src/proxy/certs.js'
import { issueUpstreamCert, trustCA } from './lib/tls-trust.js'
import type { BlockEvent } from '../../src/types.js'

/**
 * #539: the system-prompt canary, end to end. The mock upstream plays a model
 * that recites its system prompt: it finds the canary in the request it was
 * sent and streams it back, split across two deltas. The proxy must cut the
 * stream before the client has the whole token.
 */

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

let proxyCaPem = ''
const CANARY_RE = /llmfw-canary-[0-9a-f]{32}/

function dechunk(body: string): string {
  let out = '', pos = 0
  while (pos < body.length) {
    const sep = body.indexOf('\r\n', pos)
    if (sep === -1) { out += body.slice(pos); break }
    const size = parseInt(body.slice(pos, sep).trim(), 16)
    if (Number.isNaN(size) || size === 0) break
    out += body.slice(sep + 2, sep + 2 + size)
    pos = sep + 2 + size + 2
  }
  return out
}

/** POST through the proxy; resolves however the response ends (clean end or cut). */
function send(proxyPort: number, upstreamPort: number, body: string): Promise<{ statusCode: number; body: string; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const host = 'api.anthropic.com'
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT ${host}:${upstreamPort} HTTP/1.1\r\nHost: ${host}:${upstreamPort}\r\n\r\n`)
    })
    let buf = ''
    socket.on('error', reject)
    socket.on('data', function onConnect(c: Buffer) {
      buf += c.toString('binary')
      if (buf.indexOf('\r\n\r\n') === -1) return
      socket.removeListener('data', onConnect)
      const t = tls.connect({ socket, servername: host, ca: proxyCaPem, rejectUnauthorized: true }, () => {
        t.write(`POST /v1/messages HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`)
        t.write(body)
      })
      let res = ''
      let done = false
      const finish = () => {
        if (done) return
        done = true
        const sep = res.indexOf('\r\n\r\n')
        const head = sep === -1 ? res : res.slice(0, sep)
        const statusCode = parseInt((head.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10)
        const chunked = /transfer-encoding:\s*chunked/i.test(head)
        const raw = sep === -1 ? '' : res.slice(sep + 4)
        // complete: the response ended with its last chunk, not a reset.
        resolve({ statusCode, body: chunked ? dechunk(raw) : raw, complete: chunked && raw.endsWith('0\r\n\r\n') })
      }
      t.on('data', (d) => { res += d.toString('utf8') })
      t.on('end', finish)
      t.on('close', finish)
      t.on('error', finish)
    })
  })
}

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

describe('Proxy system-prompt canary (#539, E2E)', { timeout: 30000 }, () => {
  let tempDir: string
  let mockUpstream: https.Server
  let upstreamPort: number
  let restoreTrust: () => void
  let proxy: ProxyServer
  const events: BlockEvent[] = []
  const seen: { system: string; canary: string | null }[] = []

  const config = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: 18123 },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17804 },
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    dos: { ...DEFAULT_CONFIG.dos, enabled: false },
    responseScan: { ...DEFAULT_CONFIG.responseScan!, canary: { enabled: true, mode: 'block' as const } },
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-canary-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    const upstreamCert = issueUpstreamCert('api.anthropic.com')
    restoreTrust = trustCA(upstreamCert.ca)

    mockUpstream = https.createServer({ key: upstreamCert.key, cert: upstreamCert.cert }, (req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { system?: unknown; scenario?: string }
        const system = typeof parsed.system === 'string' ? parsed.system : JSON.stringify(parsed.system ?? '')
        const canary = CANARY_RE.exec(system)?.[0] ?? null
        seen.push({ system, canary })
        const leak = canary ?? 'no-canary-was-sent'
        if (parsed.scenario === 'json-leak') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: 'msg_j', type: 'message', role: 'assistant', content: [{ type: 'text', text: `My instructions end with ${leak}.` }], stop_reason: 'end_turn' }))
          return
        }
        // One event per write, paced like a model, so each reaches the proxy
        // as its own chunk.
        const events = [
          sse('message_start', { message: { id: 'msg_s', role: 'assistant', content: [] } }),
          sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'BEFORE ' } }),
          ...(parsed.scenario === 'sse-leak' ? [
            sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: leak.slice(0, 18) } }),
            sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: leak.slice(18) } }),
          ] : []),
          sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' AFTER' } }),
          sse('content_block_stop', { index: 0 }),
          sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
          sse('message_stop', {}),
        ]
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const next = (): void => {
          const ev = events.shift()
          if (ev === undefined || res.destroyed) { res.end(); return }
          res.write(ev)
          setTimeout(next, 25)
        }
        next()
      })
    })
    await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (mockUpstream.address() as net.AddressInfo).port

    proxyCaPem = new CertFactory().generateCA().cert
    const bus = new EventBus(config.dashboard)
    vi.spyOn(bus, 'emit').mockImplementation((e) => { events.push(e as BlockEvent) })
    proxy = new ProxyServer(config, bus)
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    restoreTrust()
    await proxy.stop()
    mockUpstream.closeAllConnections()
    mockUpstream.close()
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const request = (scenario: string, system?: string) => JSON.stringify({
    model: 'claude-x', max_tokens: 50, stream: scenario.startsWith('sse'), scenario,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: 'Summarise the release notes.' }],
  })

  it('adds the install token to the system prompt it forwards', async () => {
    seen.length = 0
    const res = await send(config.proxy.port, upstreamPort, request('sse-clean', 'You are the release assistant.'))
    expect(res.statusCode).toBe(200)
    expect(seen[0]?.system).toContain('You are the release assistant.')
    expect(seen[0]?.canary).toBe(fs.readFileSync(join(tempDir, 'canary.txt'), 'utf8').trim())
    // A clean stream is forwarded whole.
    expect(res.body).toContain('BEFORE ')
    expect(res.body).toContain(' AFTER')
    expect(res.body).toContain('message_stop')
  })

  it('cuts a stream that repeats the canary before the token is complete', async () => {
    events.length = 0
    const res = await send(config.proxy.port, upstreamPort, request('sse-leak', 'You are the release assistant.'))
    const token = fs.readFileSync(join(tempDir, 'canary.txt'), 'utf8').trim()
    expect(res.body).toContain('BEFORE ')
    expect(res.body).toContain(token.slice(0, 18))
    expect(res.body).not.toContain(token.slice(18))
    expect(res.body).not.toContain(' AFTER')
    const ev = events.find(e => e.stage === 'response-canary')
    expect(ev?.action).toBe('blocked')
    // #573: an error event and a clean end instead of a reset.
    expect(res.complete).toBe(true)
    expect(res.body).toMatch(/event: error\ndata: \{"type":"error","error":\{"type":"invalid_request_error","message":"llm-fw[^"]*system prompt[^"]*"\}\}\n\n$/)
  })

  it('withholds a buffered response that repeats the canary', async () => {
    events.length = 0
    const res = await send(config.proxy.port, upstreamPort, request('json-leak', 'You are the release assistant.'))
    expect(res.statusCode).toBe(502)
    expect(res.body).not.toMatch(CANARY_RE)
    expect(events.find(e => e.stage === 'response-canary')?.action).toBe('blocked')
  })

  it('sends no canary when the request has no system prompt', async () => {
    seen.length = 0
    const res = await send(config.proxy.port, upstreamPort, request('sse-clean'))
    expect(res.statusCode).toBe(200)
    expect(seen[0]?.canary).toBeNull()
  })
})
