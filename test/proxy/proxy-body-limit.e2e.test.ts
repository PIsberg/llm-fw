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

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

function generateSelfSignedCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)
  const attrs = [{ name: 'commonName', value: 'api.anthropic.com' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey)
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  }
}

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
  targetPort: number,
  path: string,
  body: Buffer
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
    })
    let buffer = ''
    socket.on('error', reject)
    socket.on('data', function onConnect(chunk: Buffer) {
      buffer += chunk.toString('binary')
      if (buffer.indexOf('\r\n\r\n') === -1) return
      socket.removeListener('data', onConnect)
      const tlsSocket = tls.connect({ socket, servername: targetHost, rejectUnauthorized: false }, () => {
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
        let body = headerSep === -1 ? '' : resData.slice(headerSep + 4)
        if (isChunked) body = dechunk(body)
        resolve({ statusCode, body })
      }
      tlsSocket.on('end', finish)
      tlsSocket.on('close', finish)
      tlsSocket.on('error', () => { if (resData) finish(); else reject(new Error('tls error')) })
    })
  })
}

describe('Proxy body-size limit (E2E)', { timeout: 20000 }, () => {
  let tempDir: string
  let mockUpstream: https.Server
  let mockUpstreamPort: number
  let receivedCount = 0

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
    new CertFactory().generateCA()
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    const certs = generateSelfSignedCert()
    mockUpstream = https.createServer(certs, (req, res) => {
      receivedCount++
      req.on('data', () => {})
      req.on('end', () => { res.writeHead(200); res.end('{"ok":true}') })
    })
    await new Promise<void>(resolve => mockUpstream.listen(0, '127.0.0.1', () => resolve()))
    mockUpstreamPort = (mockUpstream.address() as net.AddressInfo).port

    eventBus = new EventBus(testConfig.dashboard)
    proxy = new ProxyServer(testConfig, eventBus)
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'
    await proxy.stop()
    await new Promise<void>(resolve => mockUpstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('rejects a body exceeding maxBodyBytes with 413 and never forwards it', async () => {
    const before = receivedCount
    // 4 KiB body, well over the 1 KiB configured limit. Benign content + a
    // path with no parser so detection passes — only the size guard fires.
    const big = Buffer.alloc(4096, 0x61) // 'a' repeated

    const res = await sendBody(testConfig.proxy.port, 'api.anthropic.com', mockUpstreamPort, '/v1/files', big)

    expect(res.statusCode).toBe(413)
    const json = JSON.parse(res.body)
    expect(json.error).toBe('request body too large')
    expect(json.limit).toBe(1024)
    // The oversized request must never reach the upstream.
    expect(receivedCount).toBe(before)
  })

  it('allows a body under maxBodyBytes through to the upstream', async () => {
    const before = receivedCount
    const small = Buffer.alloc(256, 0x62) // 'b' repeated, under 1 KiB

    const res = await sendBody(testConfig.proxy.port, 'api.anthropic.com', mockUpstreamPort, '/v1/files', small)

    expect(res.statusCode).toBe(200)
    expect(receivedCount).toBe(before + 1)
  })
})
