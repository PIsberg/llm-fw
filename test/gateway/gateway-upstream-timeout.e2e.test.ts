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
 * An upstream that stalls after the gateway has already sent the client its
 * response headers (#531). The 504 can no longer be written, so the only
 * honest answer is to end the client's connection: before the fix the
 * gateway dropped the upstream and left the client waiting for an end that
 * never came.
 */

vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body) => ({
  result: { action: 'pass', stage: 'heuristic', score: 0 } as never,
  body,
  withheld: 0,
}))

const TOKEN = 'timeout-token'
const GATEWAY_PORT = 18231
const UPSTREAM_TIMEOUT_MS = 300

let upstream: http.Server
let upstreamPort = 0
let tempDir: string
let stall: 'after-headers' | 'before-headers' = 'after-headers'

/** Resolves with what the client saw: the status, and whether the response ended or was cut. */
function request(port: number): Promise<{ status: number; outcome: 'end' | 'aborted' | 'hung'; text: string }> {
  const payload = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'Summarise the release notes.' }] })
  return new Promise((resolve) => {
    let status = 0
    let text = ''
    const hung = setTimeout(() => { req.destroy(); resolve({ status, outcome: 'hung', text }) }, 5000)
    const done = (outcome: 'end' | 'aborted') => { clearTimeout(hung); resolve({ status, outcome, text }) }
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-llm-fw-key': TOKEN },
    }, (res) => {
      status = res.statusCode ?? 0
      res.on('data', c => { text += c })
      res.on('end', () => done('end'))
      res.on('error', () => done('aborted'))
      res.on('aborted', () => done('aborted'))
    })
    req.on('error', () => done('aborted'))
    req.write(payload)
    req.end()
  })
}

function config(): Config {
  return {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS },
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    gateway: {
      enabled: true, port: GATEWAY_PORT, bindHost: '127.0.0.1',
      requireAuth: true, authToken: TOKEN, defaultProvider: 'stand',
      providers: {
        stand: { name: 'Stand', host: '127.0.0.1', port: upstreamPort, protocol: 'http', auth: 'bearer' },
      },
    },
  }
}

describe('Gateway upstream timeout E2E (#531)', { timeout: 30000 }, () => {
  let gateway: GatewayServer
  let bus: EventBus

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-timeout-'))
    process.env.LLM_FW_DIR = tempDir
    upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (stall === 'before-headers') return
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n')
        // ...and then nothing: no more tokens, no end.
      })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as { port: number }).port
    const c = config()
    bus = new EventBus(c.dashboard)
    gateway = new GatewayServer(c, bus)
    await gateway.init()
    gateway.start()
  })

  afterAll(async () => {
    await gateway.stop()
    bus.destroy()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('cuts the client connection when the upstream stalls mid-stream', async () => {
    stall = 'after-headers'
    const res = await request(GATEWAY_PORT)
    expect(res.status).toBe(200)
    expect(res.text).toContain('Hel')
    // A clean 'end' would tell the client a truncated stream was complete.
    expect(res.outcome).toBe('aborted')
  })

  it('still answers 504 when the upstream stalls before any headers', async () => {
    stall = 'before-headers'
    const res = await request(GATEWAY_PORT)
    expect(res.status).toBe(504)
    expect(res.outcome).toBe('end')
    expect(JSON.parse(res.text).error).toBe('upstream timeout')
  })
})
