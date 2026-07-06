import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { Pipeline } from '../../src/detection/pipeline.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { UpstreamResolver } from '../../src/proxy/upstream.js'
import { CertFactory } from '../../src/proxy/certs.js'

// Task C2 — explicit detection failMode. These tests inject a THROWING
// detection stage (Pipeline.run rejects, simulating a bug in a parser/
// normalizer/stage — not a detected injection) and assert the proxy's
// request-level behavior for both modes:
//   'closed' (default; matches the pre-C2 implicit deny-on-error) → the
//            standard 403 block response, upstream never sees the request,
//            and a kind:'error' blocked event is emitted;
//   'open'   → the request is forwarded upstream unscanned and a
//            kind:'error' warned (audit) event is emitted.

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

// Track upstream forwards. Stub the upstream hop like the other proxy e2e
// suites: respond 200 without leaving the host.
let forwardedCount = 0
vi.spyOn(ProxyServer.prototype as unknown as { forwardRequest: unknown }, 'forwardRequest')
  .mockImplementation(async (..._args: unknown[]) => {
    forwardedCount++
    const res = _args[4] as http.ServerResponse
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
    return 11
  })

// The throwing stage: Pipeline.run rejects on every call. init() is stubbed
// too so the suite never loads the embedding model. checkPartial (the
// streaming-chunk pre-scan) resolves null — its errors are already swallowed
// at the call site and are not the failMode boundary under test.
vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'checkPartial').mockResolvedValue(null)
vi.spyOn(Pipeline.prototype, 'run').mockRejectedValue(new Error('injected stage failure'))

function dechunk(body: string): string {
  let result = ''
  let pos = 0
  while (pos < body.length) {
    const sep = body.indexOf('\r\n', pos)
    if (sep === -1) break
    const size = parseInt(body.slice(pos, sep).trim(), 16)
    if (isNaN(size) || size === 0) break
    const start = sep + 2
    result += body.slice(start, start + size)
    pos = start + size + 2
  }
  return result
}

async function sendBody(
  proxyPort: number,
  targetHost: string,
  caPem: string,
  path: string,
  body: Buffer
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`)
    })
    let buffer = ''
    socket.on('error', reject)
    socket.on('data', function onConnect(chunk: Buffer) {
      buffer += chunk.toString('binary')
      if (buffer.indexOf('\r\n\r\n') === -1) return
      socket.removeListener('data', onConnect)
      const tlsSocket = tls.connect({ socket, servername: targetHost, ca: [caPem] }, () => {
        tlsSocket.write(
          `POST ${path} HTTP/1.1\r\nHost: ${targetHost}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`
        )
        tlsSocket.write(body)
      })
      let resData = ''
      let done = false
      tlsSocket.on('data', (d) => { resData += d.toString('binary') })
      const finish = () => {
        if (done) return
        done = true
        const headerSep = resData.indexOf('\r\n\r\n')
        const headerPart = headerSep === -1 ? resData : resData.slice(0, headerSep)
        const lines = headerPart.split('\r\n')
        const statusCode = parseInt((lines[0] ?? '').split(' ')[1] ?? '0', 10)
        const isChunked = lines.some(l => /^transfer-encoding:\s*chunked/i.test(l))
        let b = headerSep === -1 ? '' : resData.slice(headerSep + 4)
        if (isChunked) b = dechunk(b)
        resolve({ statusCode, body: b })
      }
      tlsSocket.on('end', finish)
      tlsSocket.on('close', finish)
      tlsSocket.on('error', () => { if (resData) finish(); else reject(new Error('tls error')) })
    })
  })
}

const BODY = Buffer.from(JSON.stringify({
  model: 'claude-3-5-sonnet',
  messages: [{ role: 'user', content: 'a perfectly benign request' }],
}), 'utf-8')

function makeSuite(failMode: 'open' | 'closed', proxyPort: number, dashboardPort: number) {
  return { failMode, proxyPort, dashboardPort }
}

describe('Detection failMode (E2E, throwing pipeline stage)', { timeout: 30000 }, () => {
  describe.each([
    makeSuite('closed', 18115, 17765),
    makeSuite('open', 18116, 17766),
  ])('failMode: $failMode', ({ failMode, proxyPort, dashboardPort }) => {
    let tempDir: string
    let caPem: string
    let proxy: ProxyServer
    let eventBus: EventBus

    const testConfig = {
      ...DEFAULT_CONFIG,
      proxy: { ...DEFAULT_CONFIG.proxy, port: proxyPort },
      dashboard: { ...DEFAULT_CONFIG.dashboard, port: dashboardPort },
      detection: { ...DEFAULT_CONFIG.detection, failMode },
      // Keep the pre-pipeline stages out of the way so only the failMode
      // boundary decides the verdict.
      dos: { ...DEFAULT_CONFIG.dos, enabled: false },
      dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
      taint: { enabled: false, mode: 'audit' as const },
    }

    beforeAll(async () => {
      tempDir = fs.mkdtempSync(join(tmpdir(), `llm-fw-failmode-${failMode}-e2e-`))
      process.env.LLM_FW_DIR = tempDir
      forwardedCount = 0
      eventBus = new EventBus(testConfig.dashboard)
      proxy = new ProxyServer(testConfig, eventBus)
      caPem = (proxy as unknown as { certFactory: CertFactory }).certFactory.generateCA().cert
      await proxy.init()
      proxy.start()
    })

    afterAll(async () => {
      await proxy.stop()
      if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
    })

    if (failMode === 'closed') {
      it('blocks the request with the standard 403 block response and emits a kind:error blocked event', async () => {
        const res = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/messages', BODY)
        expect(res.statusCode).toBe(403)
        const parsed = JSON.parse(res.body) as { error: string }
        expect(parsed.error).toContain('failing closed')

        // Upstream must never have seen the request.
        expect(forwardedCount).toBe(0)

        const events = eventBus.getAll()
        const errEvent = events.find(e => e.kind === 'error')
        expect(errEvent).toBeDefined()
        expect(errEvent!.action).toBe('blocked')
        expect(errEvent!.payload_preview).toContain('failing CLOSED')
        expect(errEvent!.payload_full).toContain('injected stage failure')
      })
    } else {
      it('forwards the request upstream unscanned and emits a kind:error warned (audit) event', async () => {
        const res = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/messages', BODY)
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ ok: true })

        // The request reached the (stubbed) upstream exactly once.
        expect(forwardedCount).toBe(1)

        const events = eventBus.getAll()
        const errEvent = events.find(e => e.kind === 'error')
        expect(errEvent).toBeDefined()
        expect(errEvent!.action).toBe('warned')
        expect(errEvent!.payload_preview).toContain('failing OPEN')
        expect(errEvent!.payload_full).toContain('injected stage failure')
      })
    }
  })
})
