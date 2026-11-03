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

// Stub the upstream hop: what is under test here is the client's TLS leg.
vi.spyOn(ProxyServer.prototype as unknown as { forwardRequest: unknown }, 'forwardRequest')
  .mockImplementation(async (..._args: unknown[]) => {
    const res = _args[4] as http.ServerResponse
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })

const HOST = 'api.anthropic.com'

/**
 * Every CONNECT parsed the host's key and certificate into a new TLS context, on
 * the thread that serves every client: 4% of the busy time of the chat workload
 * at one connection per request. The context is now built once per host, which
 * also means a client may resume an earlier session. These tests pin that a
 * reused context still serves a verifiable certificate for the right host, and
 * that a resumed session reaches the same request handling.
 */
async function roundTrip(proxyPort: number, clientContext: tls.SecureContext, host: string, session?: Buffer): Promise<{ status: number; peerCn: string; resumed: boolean; session?: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
    })
    socket.on('error', reject)
    socket.once('data', () => {
      let newSession: Buffer | undefined
      const secure = tls.connect({ socket, servername: host, secureContext: clientContext, ...(session ? { session } : {}) }, () => {
        secure.write(`POST /v1/messages HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)
      })
      secure.on('session', s => { newSession = s })
      secure.on('error', reject)
      let raw = ''
      secure.on('data', c => { raw += c.toString('utf8') })
      secure.on('close', () => {
        resolve({
          status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0),
          peerCn: String(peer),
          resumed,
          ...(newSession ? { session: newSession } : {}),
        })
      })
      let peer = ''
      let resumed = false
      secure.on('secureConnect', () => {
        peer = secure.getPeerX509Certificate()?.subjectAltName ?? ''
        resumed = secure.isSessionReused()
      })
    })
  })
}

describe('TLS context reuse on the client leg', () => {
  const tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-tls-reuse-'))
  const previousDir = process.env.LLM_FW_DIR
  let proxy: ProxyServer
  let client: tls.SecureContext
  const port = 18_291

  beforeAll(async () => {
    process.env.LLM_FW_DIR = tempDir
    // Built here, so a count of contexts counts the proxy's alone.
    client = tls.createSecureContext({ ca: [new CertFactory().generateCA().cert] })
    const config = structuredClone(DEFAULT_CONFIG)
    config.proxy.port = port
    config.targets = [HOST, 'api.openai.com']
    config.detection = { ...config.detection, judgeEnabled: false }
    config.dos = { ...config.dos, loopDetectionEnabled: false }
    proxy = new ProxyServer(config, new EventBus(config.dashboard))
    proxy.start()
    await new Promise(r => setTimeout(r, 50))
  })

  afterAll(async () => {
    await proxy.stop()
    if (previousDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = previousDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('builds one context per host, however many connections it serves', async () => {
    const built = vi.spyOn(tls, 'createSecureContext')
    built.mockClear()
    for (let i = 0; i < 3; i++) expect((await roundTrip(port, client, HOST)).status).toBe(200)
    expect(built).toHaveBeenCalledTimes(1)
    built.mockRestore()
  })

  it('serves each host its own certificate, never the one built first', async () => {
    const first = await roundTrip(port, client, HOST)
    const second = await roundTrip(port, client, 'api.openai.com')
    expect(first.peerCn).toContain(HOST)
    expect(second.peerCn).toContain('api.openai.com')
    expect(second.peerCn).not.toContain(HOST)
  })

  it('answers a client that resumes an earlier session', async () => {
    const first = await roundTrip(port, client, HOST)
    expect(first.session).toBeInstanceOf(Buffer)
    const second = await roundTrip(port, client, HOST, first.session)
    expect(second.status).toBe(200)
    expect(second.resumed).toBe(true)
  })
})
