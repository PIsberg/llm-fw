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

// Capture the Buffer the proxy hands to forwardRequest. Stubbing the upstream
// hop here keeps the test focused on the fix (raw-bytes preservation) and lets
// the client→proxy TLS be validated normally against the test CA — no need to
// disable certificate validation anywhere.
let capturedBody: Buffer | null = null
vi.spyOn(ProxyServer.prototype as unknown as { forwardRequest: unknown }, 'forwardRequest')
  .mockImplementation(async (..._args: unknown[]) => {
    capturedBody = _args[3] as Buffer
    const res = _args[4] as http.ServerResponse
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })

// Send a raw Buffer body through the proxy CONNECT tunnel, validating the
// proxy's TLS cert against the supplied CA.
async function sendBinaryProxyRequest(
  proxyPort: number,
  targetHost: string,
  caPem: string,
  path: string,
  body: Buffer
): Promise<{ statusCode: number }> {
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
      if (!buffer.slice(0, buffer.indexOf('\r\n')).includes('200')) {
        reject(new Error('CONNECT failed'))
        return
      }
      const tlsSocket = tls.connect({ socket, servername: targetHost, ca: [caPem] }, () => {
        tlsSocket.write(
          `POST ${path} HTTP/1.1\r\nHost: ${targetHost}\r\n` +
          `Content-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`
        )
        tlsSocket.write(body)
      })
      let resData = ''
      tlsSocket.on('data', (d) => { resData += d.toString('binary') })
      tlsSocket.on('end', () => {
        const statusCode = parseInt((resData.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10)
        resolve({ statusCode })
      })
      tlsSocket.on('error', reject)
    })
  })
}

describe('Proxy binary integrity (E2E)', { timeout: 20000 }, () => {
  let tempDir: string
  let caPem: string
  let proxy: ProxyServer
  let eventBus: EventBus

  const testConfig = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: 18095 },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17745 },
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-bin-e2e-'))
    process.env.LLM_FW_DIR = tempDir

    eventBus = new EventBus(testConfig.dashboard)
    proxy = new ProxyServer(testConfig, eventBus)
    // Generate the CA on the proxy's OWN CertFactory so it is cached in memory
    // (getOrLoadCA returns the cached value, immune to other e2e files
    // concurrently clobbering the shared on-disk CA). caPem then validates the
    // host cert the proxy issues — no need to disable certificate validation.
    caPem = (proxy as unknown as { certFactory: CertFactory }).certFactory.generateCA().cert
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    await proxy.stop()
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('forwards a binary payload to the upstream byte-for-byte', async () => {
    // Bytes that are NOT valid standalone UTF-8 — a utf-8 round-trip would
    // replace them with U+FFFD (0xEF 0xBF 0xBD) and change the byte length.
    const payload = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, // PNG magic
      0xff, 0xfe, 0x00, 0x80, 0xc0, 0xff,
      0x00, 0x01, 0x02, 0x03,
    ])

    // Path has no registered parser → pipeline passes → request is forwarded.
    const res = await sendBinaryProxyRequest(
      testConfig.proxy.port,
      'api.anthropic.com',
      caPem,
      '/v1/files',
      payload
    )

    expect(res.statusCode).toBe(200)
    // forwardRequest must receive the exact bytes we sent — same length, same content.
    expect(capturedBody).not.toBeNull()
    expect(capturedBody!.length).toBe(payload.length)
    expect(capturedBody!.equals(payload)).toBe(true)
  })
})
