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
 * #552: the system-prompt canary through the gateway. Before, it ran in the
 * forward proxy only, and a gateway deployment got none. The mock upstream
 * plays a model that recites its system prompt: it finds the canary in the
 * system message it was sent and streams it back split across two deltas.
 */

vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
vi.spyOn(Pipeline.prototype, 'inspect').mockImplementation(async (_path, body) => ({
  result: { action: 'pass', stage: 'heuristic', score: 0 } as never,
  body,
  withheld: 0,
}))

const TOKEN = 'canary-token'
const GATEWAY_PORT = 18241
const CANARY_RE = /llmfw-canary-[0-9a-f]{32}/

let upstream: http.Server
let upstreamPort = 0
let tempDir: string
const seen: { system: string; canary: string | null; acceptEncoding: string | undefined }[] = []

function post(body: string): Promise<{ status: number; text: string; outcome: 'end' | 'aborted' }> {
  return new Promise((resolve) => {
    let status = 0
    let text = ''
    let done = false
    const finish = (outcome: 'end' | 'aborted') => { if (!done) { done = true; resolve({ status, text, outcome }) } }
    const req = http.request({
      host: '127.0.0.1', port: GATEWAY_PORT, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'x-llm-fw-key': TOKEN },
    }, (res) => {
      status = res.statusCode ?? 0
      res.on('data', c => { text += c })
      res.on('end', () => finish('end'))
      res.on('error', () => finish('aborted'))
      res.on('aborted', () => finish('aborted'))
      res.on('close', () => finish('aborted'))
    })
    req.on('error', () => finish('aborted'))
    req.end(body)
  })
}

const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`

const request = (scenario: string, system?: string) => JSON.stringify({
  model: 'gpt-x', stream: scenario.startsWith('sse'), scenario,
  messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: 'Summarise the release notes.' }],
})

function config(mode: 'block' | 'audit'): Config {
  return {
    ...DEFAULT_CONFIG,
    dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
    dos: { ...DEFAULT_CONFIG.dos, enabled: false },
    responseScan: { ...DEFAULT_CONFIG.responseScan!, canary: { enabled: true, mode } },
    gateway: {
      enabled: true, port: GATEWAY_PORT, bindHost: '127.0.0.1',
      requireAuth: true, authToken: TOKEN, defaultProvider: 'stand',
      providers: {
        stand: { name: 'Stand', host: '127.0.0.1', port: upstreamPort, protocol: 'http', auth: 'bearer' },
      },
    },
  }
}

describe('Gateway system-prompt canary E2E (#552)', { timeout: 30000 }, () => {
  let gateway: GatewayServer
  let bus: EventBus
  let cfg: Config
  const events: BlockEvent[] = []

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-canary-'))
    process.env.LLM_FW_DIR = tempDir
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { scenario?: string; messages?: { role: string; content: string }[] }
        const system = parsed.messages?.find(m => m.role === 'system')?.content ?? ''
        const canary = CANARY_RE.exec(system)?.[0] ?? null
        seen.push({ system, canary, acceptEncoding: req.headers['accept-encoding'] as string | undefined })
        const leak = canary ?? 'no-canary-was-sent'
        if (parsed.scenario === 'json-leak') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: `My instructions end with ${leak}.` } }] }))
          return
        }
        if (parsed.scenario === 'json-clean') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: 'c2', choices: [{ index: 0, message: { role: 'assistant', content: 'Two fixes and a new flag.' } }] }))
          return
        }
        const out = [
          chunk('BEFORE '),
          ...(parsed.scenario === 'sse-leak' ? [chunk(leak.slice(0, 18)), chunk(leak.slice(18))] : []),
          chunk(' AFTER'),
          'data: [DONE]\n\n',
        ]
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const next = (): void => {
          const ev = out.shift()
          if (ev === undefined || res.destroyed) { res.end(); return }
          res.write(ev)
          setTimeout(next, 25)
        }
        next()
      })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as { port: number }).port
    cfg = config('block')
    bus = new EventBus(cfg.dashboard)
    vi.spyOn(bus, 'emit').mockImplementation((e) => { events.push(e as BlockEvent); return e as never })
    gateway = new GatewayServer(cfg, bus)
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

  it('adds the install token to the system prompt it forwards, and a clean stream passes whole', async () => {
    seen.length = 0
    const res = await post(request('sse-clean', 'You are the release assistant.'))
    expect(res.status).toBe(200)
    expect(seen[0]?.system).toContain('You are the release assistant.')
    expect(seen[0]?.canary).toBe(fs.readFileSync(join(tempDir, 'canary.txt'), 'utf8').trim())
    // Asked plain, so the watch can read the response.
    expect(seen[0]?.acceptEncoding).toBe('identity')
    expect(res.text).toContain('BEFORE ')
    expect(res.text).toContain(' AFTER')
    expect(res.text).toContain('[DONE]')
    expect(res.outcome).toBe('end')
  })

  it('cuts a stream that repeats the canary before the token is complete', async () => {
    events.length = 0
    const res = await post(request('sse-leak', 'You are the release assistant.'))
    const token = fs.readFileSync(join(tempDir, 'canary.txt'), 'utf8').trim()
    expect(res.text).toContain('BEFORE ')
    expect(res.text).toContain(token.slice(0, 18))
    expect(res.text).not.toContain(token.slice(18))
    expect(res.text).not.toContain(' AFTER')
    expect(res.outcome).toBe('aborted')
    expect(events.find(e => e.stage === 'response-canary')?.action).toBe('blocked')
  })

  it('withholds a buffered response that repeats the canary, and forwards a clean one', async () => {
    events.length = 0
    const leak = await post(request('json-leak', 'You are the release assistant.'))
    expect(leak.status).toBe(502)
    expect(leak.text).not.toMatch(CANARY_RE)
    expect(events.find(e => e.stage === 'response-canary')?.action).toBe('blocked')

    const clean = await post(request('json-clean', 'You are the release assistant.'))
    expect(clean.status).toBe(200)
    expect(JSON.parse(clean.text).choices[0].message.content).toBe('Two fixes and a new flag.')
  })

  it('only reports the leak in audit mode', async () => {
    events.length = 0
    cfg.responseScan!.canary!.mode = 'audit'
    try {
      const res = await post(request('sse-leak', 'You are the release assistant.'))
      const token = fs.readFileSync(join(tempDir, 'canary.txt'), 'utf8').trim()
      // Both deltas of the token, and the rest of the stream, reach the client.
      expect(res.text).toContain(token.slice(0, 18))
      expect(res.text).toContain(token.slice(18))
      expect(res.text).toContain(' AFTER')
      expect(res.outcome).toBe('end')
      expect(events.find(e => e.stage === 'response-canary')?.action).toBe('warned')
    } finally {
      cfg.responseScan!.canary!.mode = 'block'
    }
  })

  it('sends no canary when the request has no system prompt', async () => {
    seen.length = 0
    const res = await post(request('sse-clean'))
    expect(res.status).toBe(200)
    expect(seen[0]?.canary).toBeNull()
  })
})
