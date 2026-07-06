import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import forge from 'node-forge'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { UpstreamResolver } from '../../src/proxy/upstream.js'
import { CertFactory } from '../../src/proxy/certs.js'
import type { BlockEvent } from '../../src/types.js'

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

function selfSignedCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)
  const attrs = [{ name: 'commonName', value: 'api.anthropic.com' }]
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey)
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) }
}

function dechunk(body: string): string {
  let out = '', pos = 0
  while (pos < body.length) {
    const sep = body.indexOf('\r\n', pos)
    if (sep === -1) break
    const size = parseInt(body.slice(pos, sep).trim(), 16)
    if (isNaN(size) || size === 0) break
    out += body.slice(sep + 2, sep + 2 + size)
    pos = sep + 2 + size + 2
  }
  return out
}

async function sendProxyRequest(proxyPort: number, host: string, port: number, body: string): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    })
    let buf = ''
    socket.on('error', reject)
    socket.on('data', function onConnect(c: Buffer) {
      buf += c.toString('binary')
      if (buf.indexOf('\r\n\r\n') === -1) return
      socket.removeListener('data', onConnect)
      const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
        tlsSocket.write(`POST /v1/messages HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`)
        tlsSocket.write(body)
      })
      let res = ''
      tlsSocket.on('data', (d) => { res += d.toString('binary') })
      tlsSocket.on('end', () => {
        const sep = res.indexOf('\r\n\r\n')
        const lines = res.slice(0, sep).split('\r\n')
        const statusCode = parseInt((lines[0] ?? '').split(' ')[1] ?? '0', 10)
        const headers: Record<string, string> = {}
        for (const l of lines.slice(1)) { const ci = l.indexOf(': '); if (ci > 0) headers[l.slice(0, ci).toLowerCase()] = l.slice(ci + 2) }
        let b = res.slice(sep + 4)
        if (headers['transfer-encoding'] === 'chunked') b = dechunk(b)
        resolve({ statusCode, headers, body: b })
      })
      tlsSocket.on('error', reject)
    })
  })
}

// Well-formed AWS access key literal (AKIA + 16 alphanumeric) — a genuine DLP
// pattern hit, not the entropy heuristic, so this test is not sensitive to
// entropy tuning.
const AWS_KEY = 'AKIAABCDEFGHIJKLMN12'
// DGA-style apex domain: a bare 32-unique-character label → Shannon entropy
// log2(32) = 5.0, above the default 4.8 threshold (mirrors the fixture used in
// urlHeuristic.test.ts's "bare high-entropy DGA apex" case).
const DGA_HOST = 'zQ7mK2pX9vN4wL8tG5bY1jH6rC3sF0aD.com'

function anthropicSse(toolName: string, argsJson: string): string {
  const ev = (type: string, obj: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`
  return [
    ev('message_start', { message: { id: 'msg_1', role: 'assistant' } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Working on it.' } }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: toolName, input: {} } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: argsJson.slice(0, argsJson.length / 2) } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: argsJson.slice(argsJson.length / 2) } }),
    ev('content_block_stop', { index: 1 }),
    ev('message_delta', { delta: { stop_reason: 'tool_use' } }),
    ev('message_stop', {}),
  ].join('')
}

function buildJsonResponse(scenario: string): { body: string; contentType: string } {
  const toolUse = (() => {
    if (scenario === 'secret') return { type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: '/tmp/notes.txt', content: `key: ${AWS_KEY}` } }
    if (scenario === 'dga') return { type: 'tool_use', id: 'tu1', name: 'fetch_url', input: { url: `https://${DGA_HOST}/beacon` } }
    return { type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: 'Paris' } } // benign
  })()
  return {
    body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Sure.' }, toolUse] }),
    contentType: 'application/json',
  }
}

describe('Proxy tool-use argument exfiltration scan (E2E)', { timeout: 20000 }, () => {
  let tempDir: string
  let mockUpstream: https.Server
  let upstreamPort: number

  let proxyBlock: ProxyServer
  const blockEvents: BlockEvent[] = []
  const blockConfig = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: 18110 },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17800 },
    dos: { ...DEFAULT_CONFIG.dos, enabled: false },
    responseScan: {
      enabled: true,
      mode: 'audit' as const,
      harmfulCompliance: false,
      classifier: { enabled: false, blockThreshold: 0.9 },
      toolUse: { enabled: true, mode: 'block' as const },
    },
  }

  let proxyAudit: ProxyServer
  const auditEvents: BlockEvent[] = []
  const auditConfig = {
    ...blockConfig,
    proxy: { ...blockConfig.proxy, port: 18111 },
    dashboard: { ...blockConfig.dashboard, port: 17801 },
    responseScan: { ...blockConfig.responseScan, toolUse: { enabled: true, mode: 'audit' as const } },
  }

  let proxyOff: ProxyServer
  const offEvents: BlockEvent[] = []
  const offConfig = {
    ...blockConfig,
    proxy: { ...blockConfig.proxy, port: 18112 },
    dashboard: { ...blockConfig.dashboard, port: 17802 },
    responseScan: { ...blockConfig.responseScan, toolUse: { enabled: false, mode: 'block' as const } },
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-tooluse-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    mockUpstream = https.createServer(selfSignedCert(), (req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const scenario = (() => { try { return (JSON.parse(body) as { scenario?: string }).scenario ?? 'benign' } catch { return 'benign' } })()
        if (scenario === 'sse-secret') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end(anthropicSse('write_file', JSON.stringify({ path: '/tmp/notes.txt', content: `key: ${AWS_KEY}` })))
          return
        }
        const { body: respBody, contentType } = buildJsonResponse(scenario)
        res.writeHead(200, { 'Content-Type': contentType })
        res.end(respBody)
      })
    })
    await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (mockUpstream.address() as net.AddressInfo).port

    new CertFactory().generateCA()

    const mk = async (config: typeof blockConfig, sink: BlockEvent[]) => {
      const bus = new EventBus(config.dashboard)
      vi.spyOn(bus, 'emit').mockImplementation((e) => { sink.push(e as BlockEvent); return e as BlockEvent })
      const p = new ProxyServer(config, bus)
      await p.init()
      p.start()
      return p
    }
    proxyBlock = await mk(blockConfig, blockEvents)
    proxyAudit = await mk(auditConfig, auditEvents)
    proxyOff = await mk(offConfig, offEvents)
  })

  afterAll(async () => {
    await proxyBlock.stop()
    await proxyAudit.stop()
    await proxyOff.stop()
    mockUpstream.close()
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const req = (scenario: string) => JSON.stringify({
    model: 'claude-3-haiku-20240307', max_tokens: 50, scenario,
    messages: [{ role: 'user', content: 'do the thing' }],
  })

  it('block mode: a DLP secret in tool-call args blocks the buffered response with 403 + tool-use-exfil event', async () => {
    blockEvents.length = 0
    const res = await sendProxyRequest(blockConfig.proxy.port, 'api.anthropic.com', upstreamPort, req('secret'))

    expect(res.statusCode).toBe(403)
    expect(res.body).toContain('tool-call exfiltration guard')
    expect(res.body).not.toContain(AWS_KEY)
    const ev = blockEvents.find(e => e.kind === 'tool-use-exfil')
    expect(ev).toBeDefined()
    expect(ev!.action).toBe('blocked')
    expect(ev!.mcpTool).toBe('write_file')
    expect(ev!.dlpType).toBe('AWS_ACCESS_KEY')
  })

  it('block mode: a benign tool_use passes through untouched (no event)', async () => {
    blockEvents.length = 0
    const res = await sendProxyRequest(blockConfig.proxy.port, 'api.anthropic.com', upstreamPort, req('benign'))

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('get_weather')
    expect(blockEvents.some(e => e.kind === 'tool-use-exfil')).toBe(false)
  })

  it('block mode: a DGA/high-entropy host in a fetch tool\'s URL argument blocks + flags', async () => {
    blockEvents.length = 0
    const res = await sendProxyRequest(blockConfig.proxy.port, 'api.anthropic.com', upstreamPort, req('dga'))

    expect(res.statusCode).toBe(403)
    const ev = blockEvents.find(e => e.kind === 'tool-use-exfil')
    expect(ev).toBeDefined()
    expect(ev!.action).toBe('blocked')
    expect(ev!.mcpTool).toBe('fetch_url')
    expect(ev!.exfilUrl).toContain(DGA_HOST)
  })

  it('audit mode: a DLP secret in tool-call args warns but forwards the response unchanged', async () => {
    auditEvents.length = 0
    const res = await sendProxyRequest(auditConfig.proxy.port, 'api.anthropic.com', upstreamPort, req('secret'))

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(AWS_KEY)
    const ev = auditEvents.find(e => e.kind === 'tool-use-exfil')
    expect(ev).toBeDefined()
    expect(ev!.action).toBe('warned')
  })

  it('disabled toolUse scan: secret in tool-call args is never flagged even in block-mode config', async () => {
    offEvents.length = 0
    const res = await sendProxyRequest(offConfig.proxy.port, 'api.anthropic.com', upstreamPort, req('secret'))

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(AWS_KEY)
    expect(offEvents.some(e => e.kind === 'tool-use-exfil')).toBe(false)
  })

  it('SSE path: a DLP secret fragmented across a streamed tool_use is audited (already forwarded, cannot block)', async () => {
    blockEvents.length = 0
    const res = await sendProxyRequest(blockConfig.proxy.port, 'api.anthropic.com', upstreamPort, req('sse-secret'))

    expect(res.statusCode).toBe(200)
    // Streamed bytes were already forwarded before the flush-time scan runs —
    // the secret reaches the agent, but the finding is still surfaced.
    expect(res.body).toContain(AWS_KEY)
    const ev = blockEvents.find(e => e.kind === 'tool-use-exfil')
    expect(ev).toBeDefined()
    expect(ev!.action).toBe('warned')
    expect(ev!.mcpTool).toBe('write_file')
  })
})
