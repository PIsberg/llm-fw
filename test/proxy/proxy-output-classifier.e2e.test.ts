import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import forge from 'node-forge'

// Mock the output classifier module (same pattern as the pipeline tests
// mocking InjectionClassifier) so NO model is ever downloaded: the proxy's
// wiring — mode handling, event emission, blocking — is what's under test.
const { mockClassify, mockInit } = vi.hoisted(() => ({
  mockClassify: vi.fn(),
  mockInit: vi.fn(),
}))
vi.mock('../../src/detection/outputClassifier.js', () => ({
  DEFAULT_OUTPUT_CLASSIFIER_MODEL: 'mock-model',
  OutputModerationClassifier: vi.fn(function () {
    return { init: mockInit, classify: mockClassify, isInitialized: () => true }
  }),
}))

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

async function sendProxyRequest(proxyPort: number, host: string, port: number, body: string): Promise<{ statusCode: number; body: string }> {
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
        resolve({ statusCode, body: b })
      })
      tlsSocket.on('error', reject)
    })
  })
}

const REQ = JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 50, messages: [{ role: 'user', content: 'hello there' }] })
// Deliberately benign so the regex harmfulCompliance layer never fires — only
// the mocked classifier drives the response-harm events in this suite.
const RESPONSE_TEXT = 'I am sorry, but I am not going to be answering that one today.'

describe('Proxy output-moderation classifier wiring (E2E, mocked classifier)', { timeout: 20000 }, () => {
  let tempDir: string
  let mockUpstream: https.Server
  let upstreamPort: number

  // block-mode proxy, classifier enabled
  let proxyBlock: ProxyServer
  const blockEvents: BlockEvent[] = []
  const blockConfig = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: 18096 },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17796 },
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    dos: { ...DEFAULT_CONFIG.dos, enabled: false },
    responseScan: { enabled: true, mode: 'block' as const, harmfulCompliance: true, classifier: { enabled: true, blockThreshold: 0.9 } },
  }

  // audit-mode proxy, classifier enabled
  let proxyAudit: ProxyServer
  const auditEvents: BlockEvent[] = []
  const auditConfig = {
    ...blockConfig,
    proxy: { ...blockConfig.proxy, port: 18114 },
    dashboard: { ...blockConfig.dashboard, port: 17797 },
    responseScan: { ...blockConfig.responseScan, mode: 'audit' as const },
  }

  // classifier disabled — classify() must never run
  let proxyOff: ProxyServer
  const offEvents: BlockEvent[] = []
  const offConfig = {
    ...blockConfig,
    proxy: { ...blockConfig.proxy, port: 18098 },
    dashboard: { ...blockConfig.dashboard, port: 17798 },
    responseScan: { enabled: true, mode: 'block' as const, harmfulCompliance: true, classifier: { enabled: false, blockThreshold: 0.9 } },
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-outclf-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    mockInit.mockResolvedValue(undefined)

    mockUpstream = https.createServer(selfSignedCert(), (req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        const raw = Buffer.from(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: RESPONSE_TEXT }] }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
        res.end(zlib.gzipSync(raw))
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

  beforeEach(() => {
    mockClassify.mockReset()
    blockEvents.length = 0
    auditEvents.length = 0
    offEvents.length = 0
  })

  it('block mode: a flagged verdict blocks the buffered response with 403 + blocked event', async () => {
    mockClassify.mockResolvedValue({ flagged: true, score: 0.97 })
    const res = await sendProxyRequest(blockConfig.proxy.port, 'api.anthropic.com', upstreamPort, REQ)

    expect(res.statusCode).toBe(403)
    expect(res.body).toContain('response blocked by output moderation')
    expect(res.body).not.toContain(RESPONSE_TEXT)
    const ev = blockEvents.find(e => e.kind === 'response-harm')
    expect(ev).toBeDefined()
    expect(ev!.action).toBe('blocked')
    expect(ev!.score).toBe(97)
    expect(mockClassify).toHaveBeenCalledWith(expect.stringContaining(RESPONSE_TEXT))
  })

  it('block mode: an unflagged verdict forwards the response untouched', async () => {
    mockClassify.mockResolvedValue({ flagged: false, score: 0.12 })
    const res = await sendProxyRequest(blockConfig.proxy.port, 'api.anthropic.com', upstreamPort, REQ)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(RESPONSE_TEXT)
    expect(blockEvents.some(e => e.kind === 'response-harm')).toBe(false)
  })

  it('audit mode: a flagged verdict warns but forwards the response unchanged', async () => {
    mockClassify.mockResolvedValue({ flagged: true, score: 0.95 })
    const res = await sendProxyRequest(auditConfig.proxy.port, 'api.anthropic.com', upstreamPort, REQ)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(RESPONSE_TEXT)
    const ev = auditEvents.find(e => e.kind === 'response-harm')
    expect(ev).toBeDefined()
    expect(ev!.action).toBe('warned')
  })

  it('disabled classifier: classify() is never invoked and the response passes', async () => {
    mockClassify.mockResolvedValue({ flagged: true, score: 0.99 })
    const res = await sendProxyRequest(offConfig.proxy.port, 'api.anthropic.com', upstreamPort, REQ)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(RESPONSE_TEXT)
    expect(mockClassify).not.toHaveBeenCalled()
    expect(offEvents.some(e => e.kind === 'response-harm')).toBe(false)
  })

  it('graceful degradation: a null verdict (model unavailable) forwards the response', async () => {
    // OutputModerationClassifier.classify returns null when the model failed
    // to load — the proxy must treat that exactly like "nothing to report".
    mockClassify.mockResolvedValue(null)
    const res = await sendProxyRequest(blockConfig.proxy.port, 'api.anthropic.com', upstreamPort, REQ)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(RESPONSE_TEXT)
    expect(blockEvents.some(e => e.kind === 'response-harm')).toBe(false)
  })
})
