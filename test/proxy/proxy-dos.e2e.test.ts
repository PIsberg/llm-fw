import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { UpstreamResolver } from '../../src/proxy/upstream.js'
import { CertFactory } from '../../src/proxy/certs.js'

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

// Stub the upstream hop: respond 200 without leaving the host. Keeps the test
// focused on the DoS circuit breaker; client→proxy TLS validates against the
// test CA so no certificate-validation disabling is needed.
vi.spyOn(ProxyServer.prototype as unknown as { forwardRequest: unknown }, 'forwardRequest')
  .mockImplementation(async (..._args: unknown[]) => {
    const res = _args[4] as http.ServerResponse
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })

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
): Promise<{ statusCode: number; body: string; retryAfter: string | null }> {
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
        const retryLine = lines.find(l => /^retry-after:/i.test(l))
        const retryAfter = retryLine ? retryLine.slice(retryLine.indexOf(':') + 1).trim() : null
        let b = headerSep === -1 ? '' : resData.slice(headerSep + 4)
        if (isChunked) b = dechunk(b)
        resolve({ statusCode, body: b, retryAfter })
      }
      tlsSocket.on('end', finish)
      tlsSocket.on('close', finish)
      tlsSocket.on('error', () => { if (resData) finish(); else reject(new Error('tls error')) })
    })
  })
}

describe('Proxy DoS circuit breaker (E2E)', { timeout: 30000 }, () => {
  describe('loop detection', () => {
    let tempDir: string
    let caPem: string
    let proxy: ProxyServer
    let eventBus: EventBus

    const testConfig = {
      ...DEFAULT_CONFIG,
      proxy: { ...DEFAULT_CONFIG.proxy, port: 18105 },
      dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17755 },
      // High RPM so the rate limiter never interferes — isolates the loop test.
      dos: { enabled: true, maxRequestsPerMinute: 100000, maxTokensPerSession: 1_000_000_000, loopDetectionEnabled: true },
    }

    beforeAll(async () => {
      tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-dos-loop-e2e-'))
      process.env.LLM_FW_DIR = tempDir
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

    it('breaks the circuit on the 4th identical /v1/messages request', async () => {
      // Benign body — no parser-triggered detection block, only the loop guard.
      const body = Buffer.from(JSON.stringify({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hello there, this is a benign request' }],
      }), 'utf-8')

      // Requests 1-3 pass through to the (stubbed) upstream.
      for (let i = 0; i < 3; i++) {
        const res = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/messages', body)
        expect(res.statusCode).toBe(200)
      }

      // The 4th identical request trips the loop breaker.
      const blocked = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/messages', body)
      expect(blocked.statusCode).toBe(429)
      expect(JSON.parse(blocked.body).error).toBe('Agent Loop Detected')
    })
  })

  describe('rate limiting', () => {
    let tempDir: string
    let caPem: string
    let proxy: ProxyServer
    let eventBus: EventBus

    const testConfig = {
      ...DEFAULT_CONFIG,
      proxy: { ...DEFAULT_CONFIG.proxy, port: 18106 },
      dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17756 },
      // Small RPM so the limiter trips quickly; loop detection off to isolate.
      dos: { enabled: true, maxRequestsPerMinute: 2, maxTokensPerSession: 1_000_000_000, loopDetectionEnabled: false },
    }

    beforeAll(async () => {
      tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-dos-rpm-e2e-'))
      process.env.LLM_FW_DIR = tempDir
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

    it('returns 429 with a Retry-After header once RPM is exceeded', async () => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: `unique request ${Math.random()}` }],
      }), 'utf-8')

      // First two requests are within the limit.
      const r1 = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/messages', body)
      const r2 = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/messages', body)
      expect(r1.statusCode).toBe(200)
      expect(r2.statusCode).toBe(200)

      // The 3rd request within the same minute exceeds the RPM quota.
      const r3 = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/messages', body)
      expect(r3.statusCode).toBe(429)
      expect(JSON.parse(r3.body).error).toBe('rate limit exceeded')
      expect(r3.retryAfter).not.toBeNull()
      expect(parseInt(r3.retryAfter!, 10)).toBeGreaterThan(0)
    })
  })
})
