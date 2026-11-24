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

function post(body: string, opts: { key?: string; path?: string } = {}): Promise<{ status: number; text: string; outcome: 'end' | 'aborted' }> {
  return new Promise((resolve) => {
    let status = 0
    let text = ''
    let done = false
    const finish = (outcome: 'end' | 'aborted') => { if (!done) { done = true; resolve({ status, text, outcome }) } }
    const req = http.request({
      host: '127.0.0.1', port: GATEWAY_PORT, method: 'POST', path: opts.path ?? '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'x-llm-fw-key': opts.key ?? TOKEN },
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
      tenants: {
        watching: { token: 'tok-watching', enforcement: 'observe' },
        'team-b': { token: 'tok-team-b', enforcement: 'enforce' },
      },
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
        // #859: the same leak with CRLF line endings, and one whose token
        // completes in a last event that no blank line closes.
        const crlf = parsed.scenario === 'sse-leak-crlf'
        const out = parsed.scenario === 'sse-leak-tail'
          ? [chunk('BEFORE '), chunk(leak.slice(0, 18)), chunk(leak.slice(18)).replace(/\n\n$/, '')]
          : [
            chunk('BEFORE '),
            ...(parsed.scenario === 'sse-leak' || crlf ? [chunk(leak.slice(0, 18)), chunk(leak.slice(18))] : []),
            chunk(' AFTER'),
            'data: [DONE]\n\n',
          ].map(ev => crlf ? ev.replace(/\n/g, '\r\n') : ev)
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
    // #573: the stream ends cleanly with an OpenAI error chunk, which the
    // client reports instead of retrying a lost connection.
    expect(res.outcome).toBe('end')
    expect(res.text).toMatch(/data: \{"error":\{"message":"llm-fw[^"]*system prompt[^"]*","type":"invalid_request_error","code":"llm_fw_blocked","param":null\}\}\n\n$/)
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

  // #920: a cache hit was written straight to the client, with no canary check.
  it('checks a response cache hit for the canary too', async () => {
    const cache = cfg.modules!.responseCache!
    const before = cache.enabled
    try {
      cache.enabled = true
      cfg.responseScan!.canary!.mode = 'audit'
      const body = request('json-leak', 'You are the cached release assistant.')
      expect((await post(body)).status).toBe(200)
      cfg.responseScan!.canary!.mode = 'block'
      events.length = 0
      const hit = await post(body)
      expect(hit.status).toBe(502)
      expect(hit.text).not.toMatch(CANARY_RE)
      expect(events.find(e => e.stage === 'response-canary')?.action).toBe('blocked')
    } finally {
      cache.enabled = before
      cfg.responseScan!.canary!.mode = 'block'
    }
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

  it('cuts a CRLF stream that repeats the canary (#859)', async () => {
    events.length = 0
    const res = await post(request('sse-leak-crlf', 'You are the release assistant.'))
    const token = fs.readFileSync(join(tempDir, 'canary.txt'), 'utf8').trim()
    expect(res.text).toContain('BEFORE ')
    expect(res.text).not.toContain(token.slice(18))
    expect(res.text).not.toContain(' AFTER')
    expect(events.find(e => e.stage === 'response-canary')?.action).toBe('blocked')
  })

  it('resets a stream whose last, unterminated event completes the canary (#859)', async () => {
    events.length = 0
    const res = await post(request('sse-leak-tail', 'You are the release assistant.'))
    // The event's bytes went out before the stream ended; a client drops an
    // event no blank line closed, and the reset keeps it from being taken
    // as a complete stream.
    expect(res.outcome).toBe('aborted')
    expect(events.find(e => e.stage === 'response-canary')?.action).toBe('blocked')
  })

  // #860: observe mode, the deployment's or a tenant's, must leave the
  // request as the client sent it and never refuse: the gateway added the
  // canary and cut the stream for an observing tenant.
  it('adds no canary for a tenant that observes, and forwards its stream whole (#860)', async () => {
    seen.length = 0
    events.length = 0
    const res = await post(request('sse-leak', 'You are the release assistant.'), { key: 'tok-watching' })
    expect(seen[0]?.canary).toBeNull()
    expect(seen[0]?.system).toBe('You are the release assistant.')
    expect(res.text).toContain(' AFTER')
    expect(res.outcome).toBe('end')
    expect(events.filter(e => e.stage === 'response-canary')).toEqual([])
  })

  it('adds no canary while the deployment observes, switched live (#860)', async () => {
    seen.length = 0
    cfg.enforcement = 'observe'
    try {
      const res = await post(request('sse-leak', 'You are the release assistant.'))
      expect(seen[0]?.canary).toBeNull()
      expect(res.text).toContain(' AFTER')
    } finally {
      cfg.enforcement = 'enforce'
    }
  })

  // #860: the event carried the raw request URL, a query credential
  // included, named 'gateway' as its target, and had no tenant.
  it('records the provider, the path without its query and the tenant (#860)', async () => {
    events.length = 0
    await post(request('sse-leak', 'You are the release assistant.'), { key: 'tok-team-b', path: '/v1/chat/completions?key=sk-query-credential' })
    const ev = events.find(e => e.stage === 'response-canary')
    expect(ev?.action).toBe('blocked')
    expect(ev?.path).toBe('/v1/chat/completions')
    expect(ev?.target).toBe('127.0.0.1')
    expect(ev?.tenant).toBe('team-b')
  })

  // #860: every tenant behind one ingress arrives from one address, and the
  // session key was that address, so crescendo, probe and module state of
  // one tenant was another's.
  it('keys the session on the tenant, not on the address every tenant shares (#860)', async () => {
    const inspect = vi.mocked(Pipeline.prototype.inspect)
    inspect.mockClear()
    await post(request('sse-clean', 'You are the release assistant.'), { key: 'tok-team-b' })
    await post(request('sse-clean', 'You are the release assistant.'), { key: 'tok-watching' })
    await post(request('sse-clean', 'You are the release assistant.'))
    const keys = inspect.mock.calls.map(c => (c[2] as { sessionKey?: string }).sessionKey)
    expect(keys).toEqual(['tenant:team-b', 'tenant:watching', '127.0.0.1'])
  })

  it('sends no canary when the request has no system prompt', async () => {
    seen.length = 0
    const res = await post(request('sse-clean'))
    expect(res.status).toBe(200)
    expect(seen[0]?.canary).toBeNull()
  })
})
