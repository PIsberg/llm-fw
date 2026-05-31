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

// Send a raw Buffer body through the proxy's CONNECT tunnel and resolve once
// the upstream response completes.
async function sendBinaryProxyRequest(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  path: string,
  body: Buffer
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
    })

    let buffer = ''
    socket.on('error', reject)
    socket.on('data', function onConnect(chunk: Buffer) {
      buffer += chunk.toString('binary')
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep === -1) return
      socket.removeListener('data', onConnect)
      if (!buffer.slice(0, buffer.indexOf('\r\n')).includes('200')) {
        reject(new Error('CONNECT failed'))
        return
      }

      const tlsSocket = tls.connect({ socket, servername: targetHost, rejectUnauthorized: false }, () => {
        const head =
          `POST ${path} HTTP/1.1\r\n` +
          `Host: ${targetHost}\r\n` +
          `Content-Type: application/octet-stream\r\n` +
          `Content-Length: ${body.length}\r\n` +
          `Connection: close\r\n\r\n`
        tlsSocket.write(head)
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
  let mockUpstream: https.Server
  let mockUpstreamPort: number
  let receivedBody: Buffer = Buffer.alloc(0)

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
    new CertFactory().generateCA()
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    const certs = generateSelfSignedCert()
    mockUpstream = https.createServer(certs, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.from(c)))
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
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
      mockUpstreamPort,
      '/v1/files',
      payload
    )

    expect(res.statusCode).toBe(200)
    // The upstream must receive the exact bytes we sent — same length, same content.
    expect(receivedBody.length).toBe(payload.length)
    expect(receivedBody.equals(payload)).toBe(true)
  })
})
