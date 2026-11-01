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
import { ProxyServer } from '../../../src/proxy/proxy.js'
import { EventBus } from '../../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'
import { UpstreamResolver } from '../../../src/proxy/upstream.js'
import { CertFactory } from '../../../src/proxy/certs.js'
import { issueUpstreamCert, trustCA } from '../../proxy/lib/tls-trust.js'
import type { Config } from '../../../src/types.js'

// Redirect all DNS lookups to localhost so the proxy hits our mock upstream.
// Must be patched before any ProxyServer instance is created.
;(UpstreamResolver.prototype as any).resolve = (_h: string) => Promise.resolve('127.0.0.1')

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

/**
 * Proxy config used under load: no judge, no DLP, no loop detection and no DoS
 * rate limiting, so the circuit breaker never fires and every request reaches
 * the detection stages.
 */
export function loadTestConfig(proxyPort: number, dashPort: number): Config {
  return {
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
}

export interface MockUpstream {
  port: number
  /** PEM of the CA that issued the mock's certificate; the proxy must trust it. */
  caPem: string
  close: () => Promise<void>
}

/** A mock HTTPS upstream that accepts any request and answers a dummy 200. */
export async function startMockUpstream(): Promise<MockUpstream> {
  const upstreamCert = issueUpstreamCert(TARGET_HOST)
  const server = https.createServer({ key: upstreamCert.key, cert: upstreamCert.cert }, (req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'mock', choices: [{ message: { content: 'ok' } }] }))
    })
    req.on('error', () => { /* ignore */ })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return { port, caPem: upstreamCert.ca, close: () => new Promise<void>(r => server.close(() => r())) }
}

export async function setupHarness(proxyPort: number, dashPort: number): Promise<Harness> {
  const tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-load-'))
  process.env.LLM_FW_DIR = tempDir
  const proxyCaPem = new CertFactory().generateCA().cert

  // Both TLS legs stay verified: the proxy checks the mock upstream against the
  // throwaway CA trusted here, and send() checks the proxy against its own CA.
  const mockUpstream = await startMockUpstream()
  const restoreTrust = trustCA(mockUpstream.caPem)

  const config = loadTestConfig(proxyPort, dashPort)
  const eventBus = new EventBus(config.dashboard)
  const proxy = new ProxyServer(config, eventBus)
  await proxy.init() // loads embedding model — cached in CI
  proxy.start()

  const send = createSender(proxyPort, mockUpstream.port, proxyCaPem)

  const teardown = async () => {
    restoreTrust()
    await proxy.stop()
    await mockUpstream.close()
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }

  return { send, teardown }
}

/**
 * Send one request through the proxy: a fresh CONNECT tunnel, TLS verified
 * against the proxy's CA, then `POST /v1/messages` with `Connection: close`.
 * The latency is the whole exchange, tunnel and handshake included.
 */
export function createSender(proxyPort: number, mockPort: number, proxyCaPem: string): SendFn {
  return (body: string) =>
    new Promise((resolve, reject) => {
      const t0 = performance.now()
      const elapsed = (): number => Math.round((performance.now() - t0) * 100) / 100
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
          return resolve({ statusCode: parseInt(firstLine.split(' ')[1] ?? '502', 10), latencyMs: elapsed() })
        }

        const tlsSocket = tls.connect({ socket, servername: TARGET_HOST, ca: proxyCaPem, rejectUnauthorized: true }, () => {
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
            const statusCode = parseInt(headerPart.split('\r\n')[0]?.split(' ')[1] ?? '200', 10)
            resolve({ statusCode, latencyMs: elapsed() })
          } catch (e) {
            reject(e)
          }
        })
        tlsSocket.on('error', reject)
      })
    })
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
