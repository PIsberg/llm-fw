import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Mirrors the mocking pattern in dashboard.integration.test.ts: the dashboard
// server's playground routes construct their own scanners, so a live
// Pipeline (which would try to download/load the embedding model) is mocked
// out here — the /metrics route under test only needs Pipeline.getModelStatus().
vi.mock('../../src/detection/pipeline.js', () => ({
  Pipeline: vi.fn().mockImplementation(function () {
    return {
      init: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue({
        action: 'pass',
        stage: 'none',
        score: 0,
        similarity: 0,
        heuristicMatches: [],
        nearestTemplate: '',
      }),
      getModelStatus: vi.fn().mockReturnValue({ embedding: true, classifier: false }),
    }
  }),
}))

import { createDashboardServer } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { MetricsRegistry } from '../../src/dashboard/metrics.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { Pipeline } from '../../src/detection/pipeline.js'
import type { Config } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Real loopback HTTP request against a listening server (existing convention). */
async function req(server: http.Server, method: string, path: string): Promise<{ status: number; headers: http.IncomingMessage['headers']; body: string }> {
  const addr = server.address() as { port: number }
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: addr.port, path, method }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Synthetic (non-networked) request against the server's registered
 * 'request' listener — http.createServer(listener) wires the listener via
 * `.on('request', listener)` internally, so emitting the event directly
 * invokes the exact same handler without a real socket. This is the only way
 * to exercise a NON-loopback remoteAddress deterministically: a real test
 * client connecting to 127.0.0.1 is always loopback, which the dashboard's
 * auth gate always trusts (isLoopbackAddr), so a real-socket request could
 * never observe the "remote caller, no token" 401 path.
 */
function synthReq(server: http.Server, opts: { path: string; method?: string; headers?: Record<string, string>; remoteAddress?: string }): { status: number; headers: Record<string, string>; body: string } {
  const fakeReq = {
    method: opts.method ?? 'GET',
    url: opts.path,
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress ?? '203.0.113.5' },
    on: () => fakeReq,
  } as unknown as http.IncomingMessage

  const chunks: Buffer[] = []
  const state: { code: number; headers: Record<string, string> } = { code: 0, headers: {} }
  const fakeRes = {
    writeHead(code: number, headers?: Record<string, string>) { state.code = code; state.headers = headers ?? {}; return fakeRes },
    write(chunk: unknown) { if (chunk) chunks.push(Buffer.from(chunk as string)); return true },
    end(chunk?: unknown) { if (chunk) chunks.push(Buffer.from(chunk as string)) },
  } as unknown as http.ServerResponse

  server.emit('request', fakeReq, fakeRes)
  return { status: state.code, headers: state.headers, body: Buffer.concat(chunks).toString('utf8') }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /metrics — Prometheus scrape endpoint', () => {
  let server: http.Server
  let eventBus: EventBus
  let metrics: MetricsRegistry
  let pipeline: Pipeline
  let tempDir: string

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-dashboard-metrics-'))
    process.env.LLM_FW_DIR = tempDir

    metrics = new MetricsRegistry()
    eventBus = new EventBus(DEFAULT_CONFIG.dashboard, metrics)
    pipeline = new Pipeline(DEFAULT_CONFIG)
    await pipeline.init()
    server = createDashboardServer(DEFAULT_CONFIG, eventBus, pipeline, undefined, metrics)

    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((err) => (err ? reject(err) : resolve())) })
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  }, 5000)

  it('scrapes valid Prometheus exposition format over loopback with no token required', async () => {
    const res = await req(server, 'GET', '/metrics')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toContain('# HELP llmfw_requests_total')
    expect(res.body).toContain('# TYPE llmfw_blocks_total counter')
    expect(res.body).toContain('# TYPE llmfw_scan_duration_ms histogram')
    expect(res.body).toContain('llmfw_scan_duration_ms_bucket{le="+Inf"}')
    // Model status was mocked as embedding=true, classifier=false.
    expect(res.body).toContain('llmfw_model_loaded{model="embedding"} 1')
    expect(res.body).toContain('llmfw_model_loaded{model="classifier"} 0')
  })

  it('counter values increment after simulated block/warn events and scans', async () => {
    eventBus.emit({
      stage: 'heuristic', score: 90, similarity: 0, target: 'api.anthropic.com', method: 'POST', path: '/v1/messages',
      payload_preview: 'ignore previous instructions', payload_full: 'ignore previous instructions',
      action: 'blocked',
    })
    eventBus.emit({
      stage: 'heuristic', score: 90, similarity: 0, target: 'api.anthropic.com', method: 'POST', path: '/v1/messages',
      payload_preview: 'ignore previous instructions 2', payload_full: 'ignore previous instructions 2',
      action: 'blocked',
    })
    eventBus.emit({
      stage: 'crescendo', score: 0, similarity: 0, target: 'api.anthropic.com', method: 'POST', path: '/v1/messages',
      payload_preview: 'slow escalation', payload_full: 'slow escalation',
      action: 'warned', kind: 'crescendo',
    })
    metrics.recordScan('proxy', 12)
    metrics.recordScan('proxy', 30)

    const res = await req(server, 'GET', '/metrics')
    expect(res.body).toContain('llmfw_blocks_total{stage="heuristic"} 2')
    expect(res.body).toContain('llmfw_warns_total{stage="crescendo"} 1')
    expect(res.body).toContain('llmfw_events_total{kind="crescendo"} 1')
    expect(res.body).toContain('llmfw_requests_total{surface="proxy"} 2')
  })

  it('returns 404 when config.dashboard.metrics is disabled', async () => {
    const disabledConfig: Config = { ...DEFAULT_CONFIG, dashboard: { ...DEFAULT_CONFIG.dashboard, metrics: false } }
    const disabledBus = new EventBus(disabledConfig.dashboard)
    const disabledServer = createDashboardServer(disabledConfig, disabledBus, pipeline)
    await new Promise<void>((resolve) => { disabledServer.listen(0, '127.0.0.1', () => resolve()) })
    try {
      const res = await req(disabledServer, 'GET', '/metrics')
      expect(res.status).toBe(404)
    } finally {
      disabledServer.closeAllConnections()
      await new Promise<void>((resolve, reject) => { disabledServer.close((err) => (err ? reject(err) : resolve())) })
    }
  })
})

describe('GET /metrics — auth enforcement', () => {
  // A dedicated server with an explicit token, tested via synthetic
  // (non-networked) requests so a NON-loopback remoteAddress is reachable
  // deterministically — see synthReq()'s doc comment above.
  let server: http.Server
  let pipeline: Pipeline
  const configWithToken: Config = { ...DEFAULT_CONFIG, dashboard: { ...DEFAULT_CONFIG.dashboard, authToken: 'test-token-12345' } }

  beforeAll(async () => {
    pipeline = new Pipeline(configWithToken)
    await pipeline.init()
    const eventBus = new EventBus(configWithToken.dashboard)
    server = createDashboardServer(configWithToken, eventBus, pipeline)
  })

  afterAll(() => { server.closeAllConnections() })

  it('rejects a non-loopback caller with no token (401)', () => {
    const res = synthReq(server, { path: '/metrics', remoteAddress: '203.0.113.5' })
    expect(res.status).toBe(401)
  })

  it('rejects a non-loopback caller with the WRONG token (401)', () => {
    const res = synthReq(server, { path: '/metrics', remoteAddress: '203.0.113.5', headers: { authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  it('allows a non-loopback caller presenting the correct Bearer token (200)', () => {
    const res = synthReq(server, { path: '/metrics', remoteAddress: '203.0.113.5', headers: { authorization: 'Bearer test-token-12345' } })
    expect(res.status).toBe(200)
    expect(res.body).toContain('# HELP llmfw_requests_total')
  })

  it('always allows a loopback caller regardless of token', () => {
    const res = synthReq(server, { path: '/metrics', remoteAddress: '127.0.0.1' })
    expect(res.status).toBe(200)
  })
})
