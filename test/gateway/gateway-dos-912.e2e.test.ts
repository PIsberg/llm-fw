import { describe, it, expect, vi, afterEach } from 'vitest'
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
 * #912 (maintainer decision, 2026-11-27): the gateway ran none of the proxy's
 * cost gates. The request-rate quota, the token budget and the loop detector
 * now run there too, keyed per tenant when one authenticated and by client
 * address otherwise, so one tenant's traffic never spends another's budget
 * and two clients sending the same prompt are not one looping agent.
 */

vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body) => ({
  result: { action: 'pass', stage: 'heuristic', score: 0 } as never,
  body,
  withheld: 0,
}))

const TOKEN = 'dos-token'
const GATEWAY_PORT = 18321
const events: BlockEvent[] = []
let upstreamCalls = 0

function post(path: string, body: unknown, key = TOKEN): Promise<{ status: number; text: string; retryAfter?: string }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: GATEWAY_PORT, method: 'POST', path,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-llm-fw-key': key },
    }, (res) => {
      let text = ''
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, ...(res.headers['retry-after'] ? { retryAfter: String(res.headers['retry-after']) } : {}) }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const chat = (content: string) => ({ model: 'gpt-x', messages: [{ role: 'user', content }] })
let serial = 0
const fresh = () => chat(`question ${++serial}`)

let running: { gateway: GatewayServer; upstream: http.Server; dir: string } | null = null

async function start(dos: Partial<Config['dos']>, upstreamStatus = 200): Promise<void> {
  const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-dos-'))
  process.env.LLM_FW_DIR = dir
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      upstreamCalls++
      res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }))
    })
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
  const config: Config = {
    ...DEFAULT_CONFIG,
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    dos: { ...DEFAULT_CONFIG.dos, enabled: true, loopDetectionEnabled: false, ...dos },
    gateway: {
      enabled: true, port: GATEWAY_PORT, bindHost: '127.0.0.1', requireAuth: true, authToken: TOKEN, defaultProvider: 'stand',
      tenants: { alpha: { token: 'tok-alpha' }, beta: { token: 'tok-beta' }, watching: { token: 'tok-watching', enforcement: 'observe' } },
      providers: { stand: { name: 'Stand', host: '127.0.0.1', port: (upstream.address() as { port: number }).port, protocol: 'http', auth: 'bearer' } },
    },
  }
  const bus = new EventBus(config.dashboard)
  vi.spyOn(bus, 'emit').mockImplementation((e) => { events.push(e as BlockEvent); return { ...e, id: 'ev' } as never })
  const gateway = new GatewayServer(config, bus)
  await gateway.init()
  gateway.start()
  events.length = 0
  running = { gateway, upstream, dir }
}

afterEach(async () => {
  if (!running) return
  await running.gateway.stop()
  running.upstream.closeAllConnections()
  await new Promise<void>(r => running!.upstream.close(() => r()))
  fs.rmSync(running.dir, { recursive: true, force: true })
  running = null
})

describe('Gateway cost gates, per tenant or address (#912)', { timeout: 30000 }, () => {
  it('limits requests per minute per tenant, and by address without one', async () => {
    await start({ maxRequestsPerMinute: 2 })
    expect((await post('/v1/chat/completions', fresh(), 'tok-alpha')).status).toBe(200)
    expect((await post('/v1/chat/completions', fresh(), 'tok-alpha')).status).toBe(200)
    const refused = await post('/v1/chat/completions', fresh(), 'tok-alpha')
    expect(refused.status).toBe(429)
    expect(refused.text).toContain('rate limit exceeded')
    expect(Number(refused.retryAfter)).toBeGreaterThan(0)
    expect(events.find(e => e.stage === 'dos')).toMatchObject({ action: 'blocked', dosReason: 'rate limit exceeded', tenant: 'alpha' })
    // Another tenant, and a client with no tenant, have budgets of their own.
    expect((await post('/v1/chat/completions', fresh(), 'tok-beta')).status).toBe(200)
    expect((await post('/v1/chat/completions', fresh())).status).toBe(200)
    expect((await post('/v1/chat/completions', fresh())).status).toBe(200)
    expect((await post('/v1/chat/completions', fresh())).status).toBe(429)
  })

  it('stops a tenant past its token budget and leaves the others alone', async () => {
    await start({ maxTokensPerSession: 10 })
    expect((await post('/v1/chat/completions', chat('x'.repeat(200)), 'tok-alpha')).status).toBe(200)
    const refused = await post('/v1/chat/completions', fresh(), 'tok-alpha')
    expect(refused.status).toBe(429)
    expect(refused.text).toContain('session token budget exceeded')
    expect((await post('/v1/chat/completions', fresh(), 'tok-beta')).status).toBe(200)
  })

  it('counts a body resent unchanged per tenant, so two tenants sending one prompt are not a loop', async () => {
    await start({ loopDetectionEnabled: true })
    const same = chat('summarise the report')
    for (let i = 0; i < 3; i++) expect((await post('/v1/chat/completions', same, 'tok-alpha')).status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await post('/v1/chat/completions', same, 'tok-beta')).status).toBe(200)
    const before = upstreamCalls
    const looped = await post('/v1/chat/completions', same, 'tok-alpha')
    expect(looped.status).toBe(429)
    expect(looped.text).toContain('Agent Loop Detected')
    expect(upstreamCalls).toBe(before)
    expect(events.find(e => e.dosReason === 'Agent Loop Detected')).toMatchObject({ action: 'blocked', tenant: 'alpha' })
  })

  it('does not count a call the provider refused toward a loop', async () => {
    await start({ loopDetectionEnabled: true }, 529)
    const same = chat('retry me')
    for (let i = 0; i < 5; i++) expect((await post('/v1/chat/completions', same, 'tok-alpha')).status).toBe(529)
  })

  it('records an observing tenant over its limits and forwards the request', async () => {
    await start({ maxRequestsPerMinute: 1, loopDetectionEnabled: true })
    expect((await post('/v1/chat/completions', fresh(), 'tok-watching')).status).toBe(200)
    const before = upstreamCalls
    expect((await post('/v1/chat/completions', fresh(), 'tok-watching')).status).toBe(200)
    expect(upstreamCalls).toBe(before + 1)
    expect(events.find(e => e.stage === 'dos')).toMatchObject({ action: 'blocked', enforced: false, tenant: 'watching' })
  })

  it('counts a WebSocket session against the same rate', async () => {
    await start({ maxRequestsPerMinute: 1 })
    expect((await post('/v1/chat/completions', fresh(), 'tok-alpha')).status).toBe(200)
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: GATEWAY_PORT, method: 'GET', path: '/v1/realtime?model=gpt-realtime',
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'x-llm-fw-key': 'tok-alpha' },
      })
      req.on('response', res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(429)
    expect(events.find(e => e.stage === 'dos' && e.method === 'WS')).toMatchObject({ dosReason: 'rate limit exceeded', tenant: 'alpha' })
  })

  it('runs no cost gate with dos off', async () => {
    await start({ enabled: false, maxRequestsPerMinute: 1, loopDetectionEnabled: true })
    const same = chat('again')
    for (let i = 0; i < 5; i++) expect((await post('/v1/chat/completions', same, 'tok-alpha')).status).toBe(200)
  })
})
