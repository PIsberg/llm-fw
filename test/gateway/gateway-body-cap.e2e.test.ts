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
 * `proxy.maxBodyBytes: 0` means no cap (#532), as it already did on the
 * proxy's request path and the Realtime relay. The gateway compared every
 * request against 0 and answered 413 to the first byte.
 */

vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body) => ({
  result: { action: 'pass', stage: 'heuristic', score: 0 } as never,
  body,
  withheld: 0,
}))

const TOKEN = 'body-cap-token'
const GATEWAY_PORT = 18251

let upstream: http.Server
let upstreamPort = 0
let upstreamBytes = 0
let tempDir: string

function post(port: number, payload: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-llm-fw-key': TOKEN },
    }, (res) => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function config(maxBodyBytes: number, port: number): Config {
  return {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, maxBodyBytes },
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

describe('Gateway proxy.maxBodyBytes: 0 (#532)', { timeout: 30000 }, () => {
  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-bodycap-'))
    process.env.LLM_FW_DIR = tempDir
    upstream = http.createServer((req, res) => {
      upstreamBytes = 0
      req.on('data', (c: Buffer) => { upstreamBytes += c.length })
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as { port: number }).port
  })

  afterAll(async () => {
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('forwards a request, larger than the default cap, when the cap is 0', async () => {
    const c = config(0, GATEWAY_PORT)
    const bus = new EventBus(c.dashboard)
    const gateway = new GatewayServer(c, bus)
    await gateway.init()
    gateway.start()
    try {
      const payload = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'a'.repeat(DEFAULT_CONFIG.proxy.maxBodyBytes + 1024) }] })
      const res = await post(GATEWAY_PORT, payload)
      expect(res.status).toBe(200)
      expect(upstreamBytes).toBe(Buffer.byteLength(payload))
    } finally {
      await gateway.stop()
      bus.destroy()
    }
  })

  it('still answers 413 over a positive cap', async () => {
    const c = config(1024, GATEWAY_PORT + 1)
    const bus = new EventBus(c.dashboard)
    const gateway = new GatewayServer(c, bus)
    await gateway.init()
    gateway.start()
    try {
      const res = await post(GATEWAY_PORT + 1, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'a'.repeat(4096) }] }))
      expect(res.status).toBe(413)
      expect(JSON.parse(res.text).limit_bytes).toBe(1024)
    } finally {
      await gateway.stop()
      bus.destroy()
    }
  })
})
