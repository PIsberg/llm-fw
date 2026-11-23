import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayServer } from '../../src/gateway/gateway.js'
import { Pipeline } from '../../src/detection/pipeline.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { BlockEvent, Config } from '../../src/types.js'

/**
 * #866: the gateway ran none of the proxy's MCP request checks (a blocked
 * tool definition went to the provider) and no URL-path exfil check (a query
 * carrying data out went through). Both now run on the gateway too, and an
 * observing tenant records them without refusing.
 */

vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body) => ({
  result: { action: 'pass', stage: 'heuristic', score: 0 } as never,
  body,
  withheld: 0,
}))

const TOKEN = 'parity-token'
const GATEWAY_PORT = 18242
let upstream: http.Server
let upstreamCalls = 0
let tempDir: string
const events: BlockEvent[] = []

function post(path: string, body: unknown, key = TOKEN): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: GATEWAY_PORT, method: 'POST', path,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-llm-fw-key': key },
    }, (res) => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const withTool = (name: string) => ({ model: 'gpt-x', tools: [{ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }], messages: [{ role: 'user', content: 'go' }] })

describe('Gateway request-side parity with the proxy (#866)', { timeout: 30000 }, () => {
  let gateway: GatewayServer

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-parity-'))
    process.env.LLM_FW_DIR = tempDir
    upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        upstreamCalls++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }))
      })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    const config: Config = {
      ...DEFAULT_CONFIG,
      dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
      dos: { ...DEFAULT_CONFIG.dos, enabled: false },
      gateway: {
        enabled: true, port: GATEWAY_PORT, bindHost: '127.0.0.1', requireAuth: true, authToken: TOKEN, defaultProvider: 'stand',
        tenants: { watching: { token: 'tok-watching', enforcement: 'observe' } },
        providers: { stand: { name: 'Stand', host: '127.0.0.1', port: (upstream.address() as { port: number }).port, protocol: 'http', auth: 'bearer' } },
      },
    }
    const bus = new EventBus(config.dashboard)
    vi.spyOn(bus, 'emit').mockImplementation((e) => { events.push(e as BlockEvent); return e as never })
    gateway = new GatewayServer(config, bus)
    await gateway.init()
    gateway.start()
  })

  afterAll(async () => {
    await gateway.stop()
    upstream.closeAllConnections()
    await new Promise<void>(r => upstream.close(() => r()))
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('refuses a blocked tool definition before the provider sees it', async () => {
    events.length = 0
    const before = upstreamCalls
    const res = await post('/v1/chat/completions', withTool('execute_command'))
    expect(res.status).toBe(DEFAULT_CONFIG.blockStatus ?? 422)
    expect(res.text).toContain('execute_command')
    expect(upstreamCalls).toBe(before)
    expect(events.find(e => e.stage === 'mcp-filter')).toMatchObject({ action: 'blocked', path: '/v1/chat/completions' })
  })

  it('records exposed tools and forwards the request', async () => {
    events.length = 0
    const before = upstreamCalls
    expect((await post('/v1/chat/completions', withTool('get_weather'))).status).toBe(200)
    expect(upstreamCalls).toBe(before + 1)
    expect(events.find(e => e.stage === 'mcp-filter')?.action).toBe('passed')
  })

  it('records a blocked tool definition for an observing tenant and forwards it', async () => {
    events.length = 0
    const before = upstreamCalls
    expect((await post('/v1/chat/completions', withTool('execute_command'), 'tok-watching')).status).toBe(200)
    expect(upstreamCalls).toBe(before + 1)
    expect(events.find(e => e.stage === 'mcp-filter')).toMatchObject({ action: 'blocked', enforced: false, tenant: 'watching' })
  })

  it('refuses a request whose path carries data out, as the proxy does', async () => {
    events.length = 0
    const before = upstreamCalls
    const res = await post('/v1/chat/completions?data=foo', withTool('get_weather'))
    expect(res.status).toBe(DEFAULT_CONFIG.blockStatus ?? 422)
    expect(upstreamCalls).toBe(before)
    expect(events.find(e => e.stage === 'url-filter')?.action).toBe('blocked')
  })

  it('records an exfil path for an observing tenant and forwards it', async () => {
    events.length = 0
    const before = upstreamCalls
    expect((await post('/v1/chat/completions?data=foo', withTool('get_weather'), 'tok-watching')).status).toBe(200)
    expect(upstreamCalls).toBe(before + 1)
    expect(events.find(e => e.stage === 'url-filter')).toMatchObject({ action: 'blocked', enforced: false })
  })
})
