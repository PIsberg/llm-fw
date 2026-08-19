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

// Stub the upstream hop and record whether it was reached. This keeps the test
// focused on the size guard and lets the client→proxy TLS be validated against
// the test CA — no certificate-validation disabling required.
let forwardCount = 0
vi.spyOn(ProxyServer.prototype as unknown as { forwardRequest: unknown }, 'forwardRequest')
  .mockImplementation(async (..._args: unknown[]) => {
    forwardCount++
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
          `Content-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`
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

/**
 * Two requests over ONE tunnelled TLS connection, keep-alive.
 *
 * sendBody above sets `Connection: close` and so cannot see what happens to a
 * connection the client intends to reuse, which is where the 413 teardown bug
 * lived: destroying the request stream the moment the 413 was written killed
 * the socket, and the client's NEXT request died with it.
 */
async function sendTwoOnOneConnection(
  proxyPort: number,
  targetHost: string,
  caPem: string,
  first: Buffer,
  second: Buffer,
): Promise<{ statusCodes: number[]; raw: string }> {
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

      const write = (body: Buffer) => tlsSocket.write(
        `POST /v1/messages HTTP/1.1\r\nHost: ${targetHost}\r\n` +
        `Content-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n\r\n`,
      ) && tlsSocket.write(body)

      let resData = ''
      let sentSecond = false
      let done = false
      const statuses = () => [...resData.matchAll(/HTTP\/1\.[01] (\d{3})/g)].map(m => parseInt(m[1], 10))
      const finish = () => {
        if (done) return
        done = true
        resolve({ statusCodes: statuses(), raw: resData })
      }

      const tlsSocket = tls.connect({ socket, servername: targetHost, ca: [caPem] }, () => write(first))
      tlsSocket.on('data', (d) => {
        resData += d.toString('binary')
        // As soon as the first response has fully arrived, reuse the connection.
        if (!sentSecond && statuses().length >= 1 && /\r\n\r\n/.test(resData)) {
          sentSecond = true
          setTimeout(() => { if (!tlsSocket.destroyed) write(second) }, 50)
          setTimeout(finish, 1500)
        }
      })
      tlsSocket.on('end', finish)
      tlsSocket.on('close', finish)
      tlsSocket.on('error', () => finish())
    })
  })
}

describe('Proxy body-size limit (E2E)', { timeout: 20000 }, () => {
  let tempDir: string
  let caPem: string
  let proxy: ProxyServer
  let eventBus: EventBus

  const testConfig = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: 18097, maxBodyBytes: 1024 },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17747 },
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-limit-e2e-'))
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
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('rejects a body exceeding maxBodyBytes with 413 and never forwards it', async () => {
    const before = forwardCount
    // 4 KiB body, well over the 1 KiB configured limit. Benign content + a
    // path with no parser so detection passes — only the size guard fires.
    const big = Buffer.alloc(4096, 0x61) // 'a' repeated

    const res = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/files', big)

    expect(res.statusCode).toBe(413)
    const json = JSON.parse(res.body)
    expect(json.error).toBe('request body too large')
    expect(json.limit).toBe(1024)
    // The oversized request must never reach the upstream forward.
    expect(forwardCount).toBe(before)
  })

  it('allows a body under maxBodyBytes through to the upstream', async () => {
    const before = forwardCount
    const small = Buffer.alloc(256, 0x62) // 'b' repeated, under 1 KiB

    const res = await sendBody(testConfig.proxy.port, 'api.anthropic.com', caPem, '/v1/files', small)

    expect(res.statusCode).toBe(200)
    expect(forwardCount).toBe(before + 1)
  })
  it('a refused oversized body does not kill the next request on the same tunnel', async () => {
    // Before the fix the proxy destroyed the request stream the instant the 413
    // was written: the client's pooled connection went with it, so the next,
    // unrelated request through the same tunnel got nothing back at all.
    const { statusCodes, raw } = await sendTwoOnOneConnection(
      18097, 'api.anthropic.com', caPem,
      Buffer.alloc(4096, 0x61),   // over the 1024-byte cap
      Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })),
    )
    expect(statusCodes[0]).toBe(413)
    // The refusal announces that the connection is finished. That is the whole
    // difference: a keep-alive client reads this and opens a new connection
    // instead of pooling a socket the server is about to destroy under it.
    expect(raw.toLowerCase()).toContain('connection: close')
    // And the refusal arrived whole rather than being cut off mid-flush.
    expect(raw).toContain('request body too large')
  })
})
