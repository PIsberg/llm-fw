import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayServer } from '../../src/gateway/gateway.js'
import { Pipeline } from '../../src/detection/pipeline.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

/**
 * `detection.failMode` on the gateway.
 *
 * A throw inside the pipeline is a BUG in detection, not a verdict about the
 * request, and the operator has already said which way they want that resolved.
 * The forward proxy has pinned this since Task C2; the gateway grew the same
 * handling with no test, so nothing stopped a refactor from letting the throw
 * fall through to the blanket 502 and silently ignore an availability decision
 * the Helm chart documents.
 *
 * The injected failure is Pipeline.run rejecting, exactly as a parser or
 * normalizer bug would present. It is not a detected injection.
 */

vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'run').mockRejectedValue(new Error('injected stage failure'))

const TOKEN = 'failmode-token'
const GATEWAY_PORT = 18221

let upstreamHits = 0
let upstream: http.Server
let upstreamPort = 0
let tempDir: string

function request(port: number, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-llm-fw-key': TOKEN },
    }, (res) => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => {
        let json: Record<string, unknown> | null = null
        try { json = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function configFor(failMode: 'open' | 'closed', port: number): Config {
  return {
    ...DEFAULT_CONFIG,
    detection: { ...DEFAULT_CONFIG.detection, failMode },
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    gateway: {
      enabled: true, port, bindHost: '127.0.0.1',
      requireAuth: true, authToken: TOKEN, defaultProvider: 'stand',
      providers: {
        stand: { name: 'Stand', host: '127.0.0.1', port: upstreamPort, protocol: 'http', auth: 'bearer' },
      },
    },
  }
}

const BODY = { model: 'm', messages: [{ role: 'user', content: 'Summarise the release notes.' }] }

describe('Gateway detection failMode E2E', { timeout: 60000 }, () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-failmode-'))
    process.env.LLM_FW_DIR = tempDir
    upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => { upstreamHits++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as { port: number }).port
  })

  afterAll(async () => {
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("failMode 'closed' refuses the request and never forwards it", async () => {
    const config = configFor('closed', GATEWAY_PORT)
    const bus = new EventBus(config.dashboard)
    const gateway = new GatewayServer(config, bus)
    await gateway.init()
    gateway.start()
    upstreamHits = 0

    try {
      const res = await request(GATEWAY_PORT, '/v1/chat/completions', BODY)
      expect(res.status).toBe(403)
      expect(res.json?.error).toBe('detection unavailable')
      // The client is told how to change the decision, not just that it failed.
      expect(String(res.json?.remediation)).toContain('failMode')
      expect(res.json?.event_id).toBeTruthy()
      expect(upstreamHits).toBe(0)

      const error = bus.getAll().find(e => e.kind === 'error')
      expect(error?.action).toBe('blocked')
      expect(error?.payload_preview).toContain('CLOSED')
    } finally {
      await gateway.stop()
      bus.destroy()
    }
  })

  it("failMode 'open' forwards the request unscanned and records the gap", async () => {
    const config = configFor('open', GATEWAY_PORT + 1)
    const bus = new EventBus(config.dashboard)
    const gateway = new GatewayServer(config, bus)
    await gateway.init()
    gateway.start()
    upstreamHits = 0

    try {
      const res = await request(GATEWAY_PORT + 1, '/v1/chat/completions', BODY)
      expect(res.status).toBe(200)
      expect(res.json?.ok).toBe(true)
      expect(upstreamHits).toBe(1)

      // Forwarded unscanned is an audit event, not silence: an operator has to
      // be able to find the requests that crossed while detection was broken.
      const error = bus.getAll().find(e => e.kind === 'error')
      expect(error?.action).toBe('warned')
      expect(error?.payload_preview).toContain('OPEN')
    } finally {
      await gateway.stop()
      bus.destroy()
    }
  })
})
