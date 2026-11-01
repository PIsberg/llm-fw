import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
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
 * The gateway never told the pipeline which client sent a request, so every
 * client-aware rule was skipped for gateway traffic: Claude Code's harness
 * reminders, its generated markup tags, its subagent frame and fixed notices
 * were all scored as if a person had typed them. Found live: Claude Code's own
 * attribution reminder blocked at 99.7% by the classifier through the gateway,
 * while the same request through the proxy unwraps it. The client is read from
 * the User-Agent the same way the proxy reads it.
 */

const seen: { sandboxClient?: string | undefined }[] = []
vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body, meta) => {
  seen.push({ sandboxClient: (meta as { sandboxClient?: string }).sandboxClient })
  return { result: { action: 'pass', stage: 'heuristic', score: 0 } as never, body, withheld: 0 }
})

const TOKEN = 'client-detection-token'
const GATEWAY_PORT = 18263

let upstream: http.Server
let upstreamPort = 0
let tempDir: string

function post(userAgent: string | undefined): Promise<number> {
  const payload = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }] })
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-llm-fw-key': TOKEN,
    }
    if (userAgent !== undefined) headers['user-agent'] = userAgent
    const req = http.request({ host: '127.0.0.1', port: GATEWAY_PORT, method: 'POST', path: '/v1/chat/completions', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function config(): Config {
  return {
    ...DEFAULT_CONFIG,
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

describe('Gateway tells the pipeline which client sent the request', { timeout: 30000 }, () => {
  let gateway: GatewayServer
  let bus: EventBus

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-client-'))
    process.env.LLM_FW_DIR = tempDir
    upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') })
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
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  beforeEach(() => { seen.length = 0 })

  it('passes claude-code for Claude Code\'s User-Agent', async () => {
    expect(await post('claude-cli/2.1.316 (external, cli)')).toBe(200)
    expect(seen).toEqual([{ sandboxClient: 'claude-code' }])
  })

  it('passes codex for Codex\'s User-Agent', async () => {
    expect(await post('codex_cli_rs/0.80.0 (Windows 10.0.26300; x86_64) WindowsTerminal')).toBe(200)
    expect(seen).toEqual([{ sandboxClient: 'codex' }])
  })

  it('passes unknown when the User-Agent names no known client, or is absent', async () => {
    expect(await post('curl/8.9.1')).toBe(200)
    expect(await post(undefined)).toBe(200)
    expect(seen).toEqual([{ sandboxClient: 'unknown' }, { sandboxClient: 'unknown' }])
  })
})
