import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayServer } from '../../src/gateway/gateway.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { BlockEvent, Config } from '../../src/types.js'

/**
 * Observation must not alter the request.
 *
 * DLP runs before the detection pipeline and, in the shipped default
 * configuration, runs in `redact` mode — it rewrites the body in place. A
 * tenant configured with `enforcement: 'observe'` was still having its request
 * silently rewritten, because the DLP branch read the deployment-wide
 * `dlp.mode` and never consulted the tenant. With `LLM_FW_DLP_MODE=block` the
 * observing tenant was refused outright.
 *
 * That is the exact promise observe mode is sold on, so it gets its own suite
 * with DLP left ENABLED — the main gateway E2E suite disables DLP to keep its
 * assertions about routing clean, which is why this slipped through.
 */

const GATEWAY_PORT = 18211
const SHARED_TOKEN = 'shared-token'
// A payload DLP recognises. Not a real credential: the prefix is what the
// detector matches on.
const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

interface UpstreamCall { headers: http.IncomingHttpHeaders; body: string }

async function post(path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: GATEWAY_PORT, method: 'POST', path,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...headers },
      },
      (res) => {
        let text = ''
        res.on('data', c => { text += c })
        res.on('end', () => {
          let json: Record<string, unknown> | null = null
          try { json = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

describe('Gateway DLP under per-tenant observe', { timeout: 60000 }, () => {
  let tempDir: string
  let gateway: GatewayServer
  let upstream: http.Server
  let calls: UpstreamCall[] = []
  let events: BlockEvent[] = []

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-dlp-'))
    process.env.LLM_FW_DIR = tempDir

    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        calls.push({ headers: req.headers, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    const upstreamPort = (upstream.address() as { port: number }).port

    const config: Config = {
      ...DEFAULT_CONFIG,
      // DLP left ON at its shipped default (redact) — the point of this suite.
      dlp: { ...DEFAULT_CONFIG.dlp, enabled: true, mode: 'redact' },
      gateway: {
        enabled: true,
        port: GATEWAY_PORT,
        bindHost: '127.0.0.1',
        requireAuth: true,
        authToken: SHARED_TOKEN,
        defaultProvider: 'testprovider',
        tenants: {
          observing: { token: 'tok-observing', enforcement: 'observe' },
        },
        providers: {
          testprovider: { name: 'Test', host: '127.0.0.1', port: upstreamPort, protocol: 'http', auth: 'bearer' },
        },
      },
    }

    const bus = new EventBus(config.dashboard)
    const originalEmit = bus.emit.bind(bus)
    bus.emit = (partial) => { const e = originalEmit(partial); events.push(e); return e }

    gateway = new GatewayServer(config, bus)
    await gateway.init()
    gateway.start()
  })

  afterAll(async () => {
    await gateway?.stop()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const body = { model: 'test', messages: [{ role: 'user', content: `Here is the key ${SECRET} for the test account.` }] }

  it('redacts for an enforcing caller', async () => {
    calls = []; events = []
    const res = await post('/v1/chat/completions', body, { 'x-llm-fw-key': SHARED_TOKEN })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    // Baseline: the shipped behaviour rewrites the body.
    expect(calls[0]!.body).not.toContain(SECRET)
  })

  it('forwards an observing tenant body byte-for-byte', async () => {
    calls = []; events = []
    const res = await post('/v1/chat/completions', body, { 'x-llm-fw-key': 'tok-observing' })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    // Observation must not alter the request it is observing.
    expect(calls[0]!.body).toBe(JSON.stringify(body))
    expect(calls[0]!.body).toContain(SECRET)
  })

  it('still records the DLP finding for the observing tenant, attributed and unenforced', async () => {
    calls = []; events = []
    await post('/v1/chat/completions', body, { 'x-llm-fw-key': 'tok-observing' })

    const dlp = events.filter(e => e.kind === 'dlp')
    expect(dlp.length).toBeGreaterThan(0)
    // The operator still needs to see what DLP found, whose traffic it was,
    // and that nothing was done about it.
    expect(dlp[0]!.tenant).toBe('observing')
    expect(dlp[0]!.enforced).toBe(false)
  })
})
