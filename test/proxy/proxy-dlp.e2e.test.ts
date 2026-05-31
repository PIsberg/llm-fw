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
import { Config } from '../../src/types.js'

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

// Stub the upstream hop. Capture the body buffer the proxy forwards so the
// redact-mode test can assert on the rewritten payload. The client→proxy TLS is
// validated against the test CA — no certificate-validation disabling.
let capturedBody: Buffer | null = null
vi.spyOn(ProxyServer.prototype as unknown as { forwardRequest: unknown }, 'forwardRequest')
  .mockImplementation(async (..._args: unknown[]) => {
    capturedBody = _args[3] as Buffer
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

const GH_TOKEN = 'ghp_' + 'a'.repeat(36)
const MARKER = '[REDACTED_GITHUB_TOKEN]'

function anthropicBody(secret: string): Buffer {
  return Buffer.from(JSON.stringify({
    model: 'claude-3-haiku-20240307',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Here is my deploy token: ' + secret }],
  }), 'utf-8')
}

function makeConfig(mode: 'block' | 'redact', port: number, dashPort: number): Config {
  return {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: dashPort },
    dlp: { ...DEFAULT_CONFIG.dlp, mode },
  }
}

describe('Proxy DLP block mode (E2E)', { timeout: 20000 }, () => {
  let tempDir: string
  let caPem: string
  let proxy: ProxyServer

  const testConfig = makeConfig('block', 18101, 17751)

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-dlp-block-'))
    process.env.LLM_FW_DIR = tempDir
    const eventBus = new EventBus(testConfig.dashboard)
    proxy = new ProxyServer(testConfig, eventBus)
    caPem = (proxy as unknown as { certFactory: CertFactory }).certFactory.generateCA().cert
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    await proxy.stop()
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('blocks a request whose prompt embeds a GitHub token with 403', async () => {
    const res = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/messages', anthropicBody(GH_TOKEN))
    expect(res.statusCode).toBe(403)
    const json = JSON.parse(res.body)
    expect(json.error).toBe('sensitive data detected')
    expect(json.type).toBe('GITHUB_TOKEN')
  })
})

describe('Proxy DLP redact mode (E2E)', { timeout: 20000 }, () => {
  let tempDir: string
  let caPem: string
  let proxy: ProxyServer

  const testConfig = makeConfig('redact', 18102, 17752)

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-dlp-redact-'))
    process.env.LLM_FW_DIR = tempDir
    const eventBus = new EventBus(testConfig.dashboard)
    proxy = new ProxyServer(testConfig, eventBus)
    caPem = (proxy as unknown as { certFactory: CertFactory }).certFactory.generateCA().cert
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    await proxy.stop()
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('redacts the token from the forwarded body and returns 200', async () => {
    capturedBody = null
    const res = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/messages', anthropicBody(GH_TOKEN))
    expect(res.statusCode).toBe(200)
    expect(capturedBody).not.toBeNull()
    const forwarded = capturedBody!.toString('utf-8')
    expect(forwarded).not.toContain(GH_TOKEN)
    expect(forwarded).toContain(MARKER)
    // Forwarded body remains valid JSON.
    expect(() => JSON.parse(forwarded)).not.toThrow()
  })
})
