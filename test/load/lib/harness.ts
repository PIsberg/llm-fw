/**
 * Shared load-test harness: spins up the proxy + a mock HTTPS upstream in-process,
 * and exposes a `send(body)` function that sends a request through the full proxy
 * pipeline and returns { statusCode, latencyMs }.
 *
 * No external tools needed — mirrors the pattern in test/proxy/proxy.e2e.test.ts.
 */
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import forge from 'node-forge'
import { ProxyServer } from '../../../src/proxy/proxy.js'
import { EventBus } from '../../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'
import { UpstreamResolver } from '../../../src/proxy/upstream.js'
import { CertFactory } from '../../../src/proxy/certs.js'
import type { Config } from '../../../src/types.js'

// Redirect all DNS lookups to localhost so the proxy hits our mock upstream.
// Must be patched before any ProxyServer instance is created.
;(UpstreamResolver.prototype as any).resolve = (_h: string) => Promise.resolve('127.0.0.1')

function buildSelfSignedCert(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)
  const attrs = [{ name: 'commonName', value: 'mock-upstream' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey)
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  }
}

function dechunk(body: string): string {
  let pos = 0, result = ''
  while (pos < body.length) {
    const nl = body.indexOf('\r\n', pos)
    if (nl === -1) break
    const size = parseInt(body.slice(pos, nl).trim(), 16)
    if (isNaN(size) || size === 0) break
    result += body.slice(nl + 2, nl + 2 + size)
    pos = nl + 2 + size + 2
  }
  return result
}

export interface SendResult {
  statusCode: number
  latencyMs: number
}

export type SendFn = (body: string) => Promise<SendResult>

export interface Harness {
  send: SendFn
  teardown: () => Promise<void>
}

const TARGET_HOST = 'api.anthropic.com'
const REQUEST_TIMEOUT_MS = 10_000

export async function setupHarness(proxyPort: number, dashPort: number): Promise<Harness> {
  const tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-load-'))
  process.env.LLM_FW_DIR = tempDir
  // Allow the proxy's dynamically-generated CA to be accepted by Node TLS.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  new CertFactory().generateCA()

  // Mock upstream HTTPS server — accepts any request and returns a dummy 200.
  const mockCerts = buildSelfSignedCert()
  const mockUpstream = https.createServer(mockCerts, (req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'mock', choices: [{ message: { content: 'ok' } }] }))
    })
    req.on('error', () => { /* ignore */ })
  })
  await new Promise<void>(r => mockUpstream.listen(0, '127.0.0.1', () => r()))
  const mockPort = (mockUpstream.address() as { port: number }).port

  // Proxy config optimised for load testing: no judge, no loop detection,
  // no DoS rate limiting so the circuit breaker doesn't fire under load.
  const config: Config = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: proxyPort },
    detection: { ...DEFAULT_CONFIG.detection, judgeEnabled: false },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: dashPort },
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    rag: { enabled: false },
    dos: {
      ...DEFAULT_CONFIG.dos,
      maxRequestsPerMinute: 100_000,
      maxTokensPerSession: 1_000_000_000,
      loopDetectionEnabled: false,
    },
    targets: [TARGET_HOST],
  }

  const eventBus = new EventBus(config.dashboard)
  const proxy = new ProxyServer(config, eventBus)
  await proxy.init() // loads embedding model — cached in CI
  proxy.start()

  const send: SendFn = (body: string) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now()
      const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort })

      socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
        socket.destroy()
        reject(new Error('request timed out'))
      })
      socket.on('error', reject)

      socket.once('connect', () => {
        socket.write(`CONNECT ${TARGET_HOST}:${mockPort} HTTP/1.1\r\nHost: ${TARGET_HOST}:${mockPort}\r\n\r\n`)
      })

      let buf = ''
      let tunnelUp = false

      socket.on('data', (chunk) => {
        if (tunnelUp) return // TLS takes over after this point
        buf += chunk.toString('binary')
        const sep = buf.indexOf('\r\n\r\n')
        if (sep === -1) return

        tunnelUp = true
        socket.removeAllListeners('data')

        const firstLine = buf.slice(0, buf.indexOf('\r\n'))
        if (!firstLine.includes('200')) {
          socket.destroy()
          return resolve({ statusCode: parseInt(firstLine.split(' ')[1] ?? '502', 10), latencyMs: Date.now() - t0 })
        }

        const tlsSocket = tls.connect({ socket, servername: TARGET_HOST, rejectUnauthorized: false }, () => {
          const bodyLen = Buffer.byteLength(body)
          tlsSocket.write(
            `POST /v1/messages HTTP/1.1\r\n` +
            `Host: ${TARGET_HOST}\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${bodyLen}\r\n` +
            `Connection: close\r\n\r\n`
          )
          tlsSocket.write(body)
        })

        let res = ''
        tlsSocket.on('data', d => { res += d.toString('binary') })
        tlsSocket.on('end', () => {
          try {
            const headerEnd = res.indexOf('\r\n\r\n')
            if (headerEnd === -1) return reject(new Error('malformed response'))
            const headerPart = res.slice(0, headerEnd)
            let resBody = res.slice(headerEnd + 4)
            const statusCode = parseInt(headerPart.split('\r\n')[0]?.split(' ')[1] ?? '200', 10)
            const hdrs: Record<string, string> = {}
            for (const line of headerPart.split('\r\n').slice(1)) {
              const ci = line.indexOf(': ')
              if (ci > 0) hdrs[line.slice(0, ci).toLowerCase()] = line.slice(ci + 2)
            }
            if (hdrs['transfer-encoding'] === 'chunked') resBody = dechunk(resBody)
            resolve({ statusCode, latencyMs: Date.now() - t0 })
          } catch (e) {
            reject(e)
          }
        })
        tlsSocket.on('error', reject)
      })
    })

  const teardown = async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'
    await proxy.stop()
    await new Promise<void>(r => mockUpstream.close(() => r()))
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }

  return { send, teardown }
}

/** Return the p-th percentile of a pre-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!
}

/** Pretty-print a two-column table to stdout. */
export function printTable(title: string, rows: [string, string | number][]): void {
  console.log(`\n${title}`)
  console.log('─'.repeat(48))
  const maxKey = Math.max(...rows.map(r => String(r[0]).length))
  for (const [k, v] of rows) {
    console.log(`  ${String(k).padEnd(maxKey)}  ${v}`)
  }
}

/** Format milliseconds for display. */
export function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`
}
