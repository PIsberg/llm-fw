import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { UpstreamResolver } from '../../src/proxy/upstream.js'
import { CertFactory } from '../../src/proxy/certs.js'
import { issueUpstreamCert, trustCA } from './lib/tls-trust.js'
import type { Config } from '../../src/types.js'

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

// #920: with upstream keep-alive off (the default) the proxy finished a
// response only when the provider closed the connection. One that sent the
// whole answer and kept the connection open, whatever Connection: close said,
// held the client until upstreamTimeoutMs and then answered 502.
const PROXY_PORT = 18311
const BODY = '{"data":[{"id":"m1"}]}'

describe('a complete response on a connection the provider keeps open (#920)', { timeout: 30_000 }, () => {
  let tempDir: string
  let proxyCa: string
  let restoreTrust: () => void
  let proxy: ProxyServer
  let upstream: tls.Server
  let upstreamPort = 0
  const held: tls.TLSSocket[] = []

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-framing-920-'))
    process.env.LLM_FW_DIR = tempDir
    proxyCa = new CertFactory().generateCA().cert
    const cert = issueUpstreamCert('api.anthropic.com')
    restoreTrust = trustCA(cert.ca)
    upstream = tls.createServer({ key: cert.key, cert: cert.cert }, (sock) => {
      held.push(sock)
      let head = ''
      sock.on('data', (d: Buffer) => {
        head += d.toString('latin1')
        if (!head.includes('\r\n\r\n')) return
        const chunked = head.startsWith('GET /chunked')
        sock.write(chunked
          ? `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${BODY.length.toString(16)}\r\n${BODY}\r\n0\r\n\r\n`
          : `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`)
        // ... and never ends the connection.
      })
      sock.on('error', () => {})
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (upstream.address() as net.AddressInfo).port
    const config: Config = {
      ...DEFAULT_CONFIG,
      proxy: { ...DEFAULT_CONFIG.proxy, port: PROXY_PORT, upstreamTimeoutMs: 6000, upstreamKeepAlive: false },
      detection: { ...DEFAULT_CONFIG.detection, judgeEnabled: false },
    }
    proxy = new ProxyServer(config, new EventBus(config.dashboard))
    await proxy.init()
    proxy.start()
  }, 60_000)

  afterAll(async () => {
    for (const s of held) s.destroy()
    await proxy?.stop()
    await new Promise<void>(r => upstream.close(() => r()))
    restoreTrust?.()
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function get(path: string): Promise<{ status: number; body: string; ms: number }> {
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const raw = net.createConnection({ host: '127.0.0.1', port: PROXY_PORT }, () => raw.write(`CONNECT api.anthropic.com:${upstreamPort} HTTP/1.1\r\nHost: api.anthropic.com:${upstreamPort}\r\n\r\n`))
      raw.once('data', () => {
        const t = tls.connect({ socket: raw, servername: 'api.anthropic.com', ca: proxyCa }, () => {
          t.write(`GET ${path} HTTP/1.1\r\nHost: api.anthropic.com\r\nx-api-key: sk-test\r\nConnection: close\r\n\r\n`)
        })
        let res = ''
        t.on('data', d => { res += d.toString('utf8') })
        t.on('end', () => {
          const sep = res.indexOf('\r\n\r\n')
          const status = Number(res.slice(9, 12))
          let body = res.slice(sep + 4)
          if (/transfer-encoding:\s*chunked/i.test(res.slice(0, sep))) body = body.split('\r\n').filter((_, i) => i % 2 === 1).join('')
          resolve({ status, body, ms: Date.now() - started })
        })
        t.on('error', reject)
      })
      raw.on('error', reject)
    })
  }

  it.each([['a Content-Length body', '/v1/models'], ['a chunked body', '/chunked/v1/models']])('answers %s as soon as it is whole', async (_label, path) => {
    const r = await get(path)
    expect(r.status).toBe(200)
    expect(r.body).toBe(BODY)
    expect(r.ms).toBeLessThan(3000)
  })
})
