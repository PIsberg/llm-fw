import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayServer } from '../../src/gateway/gateway.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { createDashboardServer } from '../../src/dashboard/server.js'
import { ModuleManager } from '../../src/modules/registry.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { Screening } from '../../src/modules/screening.js'
import { collectTextSlots } from '../../src/modules/payload.js'
import { isLoopbackAddr } from '../../src/auth.js'
import type { Config } from '../../src/types.js'
import { ScreenedProbe, markBody, PROBE_FIELD } from '../modules/fixtures/screenedProbe.js'

const TOKEN = 'gw-modules-test-token'
const GATEWAY_PORT = 18205

interface UpstreamCall { path: string; headers: http.IncomingHttpHeaders; body: string }

function reqHttp(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          ...(payload ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
      },
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

describe('Gateway & Dashboard Modules Live Session', { timeout: 30000 }, () => {
  let tempDir: string
  let gateway: GatewayServer
  let dashboardServer: http.Server
  let dashboardPort = 0
  let upstream: http.Server
  let calls: UpstreamCall[] = []
  let upstreamPort = 0
  let moduleManager: ModuleManager
  let eventBus: EventBus
  let config: Config
  // A module that runs after detection and DLP (afterScreening), registered
  // beside the built-in ones; disabled until a case of the post-screening
  // describe at the end of this suite turns it on.
  const probe = new ScreenedProbe()

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-modules-'))
    process.env.LLM_FW_DIR = tempDir

    // Stand-in upstream echoes received body
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        calls.push({ path: req.url ?? '', headers: req.headers, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, received: body, usage: { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 } } }))
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
    upstreamPort = (upstream.address() as { port: number }).port

    config = {
      ...DEFAULT_CONFIG,
      dlp: { ...DEFAULT_CONFIG.dlp, enabled: false },
      detection: {
        ...DEFAULT_CONFIG.detection,
        // Disable judge and heavy models in e2e to keep test fast
        judgeEnabled: false,
      },
      modules: {
        enabled: true,
        tokenPruner: { enabled: true },
      },
      gateway: {
        enabled: true,
        port: GATEWAY_PORT,
        bindHost: '127.0.0.1',
        requireAuth: true,
        authToken: TOKEN,
        defaultProvider: 'testprovider',
        providers: {
          testprovider: {
            name: 'Test',
            host: '127.0.0.1',
            port: upstreamPort,
            protocol: 'http',
            auth: 'bearer',
            apiKey: 'test-key',
          },
        },
      },
    }

    eventBus = new EventBus(config.dashboard)
    moduleManager = new ModuleManager(config)
    moduleManager.register(probe)

    gateway = new GatewayServer(config, eventBus, undefined, undefined, moduleManager)
    await gateway.init()
    gateway.start()

    dashboardServer = createDashboardServer(config, eventBus, undefined as any, undefined, undefined, moduleManager)
    await new Promise<void>((resolve) => dashboardServer.listen(0, '127.0.0.1', () => resolve()))
    dashboardPort = (dashboardServer.address() as { port: number }).port
  })

  afterAll(async () => {
    await gateway?.stop()
    dashboardServer.closeAllConnections()
    await new Promise<void>((resolve) => dashboardServer.close(() => resolve()))
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('prunes multiline JSON and unnecessary whitespace while strictly preserving code indentation', async () => {
    calls = []
    const rawContent = `Hello    world!   Here is some data:
{
  "user": "alice",
  "action": "login",
  "active": true
}

And some code:
\`\`\`python
def calculate(x):
    if x > 0:
        return x * 2
    return 0
\`\`\`
`
    const requestPayload = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: rawContent }],
    })

    const res = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', requestPayload, {
      'x-llm-fw-key': TOKEN,
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const receivedPayload = JSON.parse(calls[0]!.body)
    const receivedContent: string = receivedPayload.messages[0].content

    // 1. JSON was minified
    expect(receivedContent).toContain('{"user":"alice","action":"login","active":true}')

    // 2. Extra spaces collapsed
    expect(receivedContent).toContain('Hello world! Here is some data:')

    // 3. Python indentation preserved intact
    expect(receivedContent).toContain('def calculate(x):\n    if x > 0:\n        return x * 2\n    return 0')

    // 4. Module stats updated
    const statsRes = await reqHttp(dashboardPort, 'GET', '/api/modules')
    expect(statsRes.status).toBe(200)
    const stats = JSON.parse(statsRes.body)
    expect(stats.totalTokensSaved).toBeGreaterThan(0)
    expect(stats.overallPercentSaved).toBeGreaterThan(0)
    const pruner = stats.modules.find((m: { id: string }) => m.id === 'token-pruner')
    expect(pruner?.enabled).toBe(true)
  })

  it('replays a repeated request from the response cache without calling upstream', async () => {
    config.modules!.responseCache!.enabled = true
    try {
      calls = []
      const payload = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'cache me please' }] })
      const first = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', payload, { 'x-llm-fw-key': TOKEN })
      const second = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', payload, { 'x-llm-fw-key': TOKEN })
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(second.body).toBe(first.body)
      expect(second.headers['x-llm-fw-cache']).toBe('hit')
      expect(first.headers['x-llm-fw-cache']).toBeUndefined()
    } finally {
      config.modules!.responseCache!.enabled = false
    }
  })

  it('keeps cached responses apart by the credential in the query', async () => {
    config.modules!.responseCache!.enabled = true
    try {
      calls = []
      const payload = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'cache per key' }] })
      const send = (key: string) => reqHttp(GATEWAY_PORT, 'POST', `/v1/chat/completions?key=${key}`, payload, { 'x-llm-fw-key': TOKEN })
      await send('one')
      await send('two')
      await send('one')
      expect(calls).toHaveLength(2)
    } finally {
      config.modules!.responseCache!.enabled = false
    }
  })

  it('meters the usage the provider reported in its response', async () => {
    const before = JSON.parse((await reqHttp(dashboardPort, 'GET', '/api/modules')).body)
    const kpi = (stats: any, key: string) =>
      stats.modules.find((m: { id: string }) => m.id === 'usage-meter').kpis.find((k: { key: string }) => k.key === key).value
    const res = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    }), { 'x-llm-fw-key': TOKEN })
    expect(res.status).toBe(200)

    const after = JSON.parse((await reqHttp(dashboardPort, 'GET', '/api/modules')).body)
    expect(kpi(after, 'responses') - kpi(before, 'responses')).toBe(1)
    expect(kpi(after, 'cacheRead') - kpi(before, 'cacheRead')).toBe(100)
    expect(kpi(after, 'input') - kpi(before, 'input')).toBe(20)
    expect(kpi(after, 'output') - kpi(before, 'output')).toBe(8)
  })

  it('SSE endpoint /events receives replayed module events', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: dashboardPort,
          method: 'GET',
          path: '/events',
        },
        (res) => {
          let buffer = ''
          res.on('data', (c) => {
            buffer += String(c)
            if (buffer.includes('event: module')) {
              request.destroy()
              resolve(buffer)
            }
          })
          res.on('error', reject)
        },
      )
      request.on('error', (err) => {
        if ((err as any).code !== 'ECONNRESET') reject(err)
      })
      request.end()
    })

    expect(body).toContain('event: module')
    expect(body).toContain('token-pruner')
  })

  it('dynamically disables token pruner via settings without restart', async () => {
    // Disable via settings
    const saveRes = await reqHttp(dashboardPort, 'POST', '/api/settings', JSON.stringify({ tokenPruner: false }))
    expect(saveRes.status).toBe(200)

    calls = []
    const rawContent = `Unpruned    text    with    spaces
{
  "keep": "multiline",
  "formatting": true
}`
    const requestPayload = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: rawContent }],
    })

    const res = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', requestPayload, {
      'x-llm-fw-key': TOKEN,
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const receivedPayload = JSON.parse(calls[0]!.body)
    // Left completely unchanged because token pruner was disabled
    expect(receivedPayload.messages[0].content).toBe(rawContent)
  })

  it('dynamically re-enables token pruner via settings without restart', async () => {
    // Re-enable via settings
    const saveRes = await reqHttp(dashboardPort, 'POST', '/api/settings', JSON.stringify({ tokenPruner: true }))
    expect(saveRes.status).toBe(200)

    calls = []
    const rawContent = `Re-enabled    pruner    with    spaces:
{
  "compact": "me"
}`
    const requestPayload = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: rawContent }],
    })

    const res = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', requestPayload, {
      'x-llm-fw-key': TOKEN,
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const receivedPayload = JSON.parse(calls[0]!.body)
    expect(receivedPayload.messages[0].content).toContain('{"compact":"me"}')
    expect(receivedPayload.messages[0].content).toContain('Re-enabled pruner with spaces:')
  })

  it('observe mode forwards the original body and reports the saving as not applied', async () => {
    config.enforcement = 'observe'
    try {
      calls = []
      const rawContent = 'Observed    request    with    spaces'
      const res = await reqHttp(GATEWAY_PORT, 'POST', '/v1/chat/completions', JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: rawContent }],
      }), { 'x-llm-fw-key': TOKEN })

      expect(res.status).toBe(200)
      expect(JSON.parse(calls[0]!.body).messages[0].content).toBe(rawContent)
      const last = eventBus.getRecentModuleEvents(1)[0]
      expect(last?.applied).toBe(false)
    } finally {
      config.enforcement = 'enforce'
    }
  })

  // A module marked afterScreening runs once DLP and the pipeline have passed
  // the request, on the body that would be forwarded, and what it returns is
  // forwarded (specs/001-tool-result-shunt: FR-012, FR-015, US4-4, plan Design
  // 1 and 2). The same cases as the proxy's, minus the quota: the gateway's
  // tenant quota counts requests and is charged before screening.
  describe('a module that runs after detection and DLP (afterScreening)', () => {
    const GH_TOKEN = 'ghp_' + 'a'.repeat(36)
    const CLEAN = 'tests: 12 passed, 0 failed'
    const LINT = 'lint: no problems found in 40 files'
    // The first corpus attack of the override family blocks at the heuristic stage when it
    // is a tool result (checked at the pipeline directly, 2026-10-17).
    const INJECTION = (JSON.parse(fs.readFileSync(new URL('../detection/fixtures/corpus.json', import.meta.url), 'utf8')) as
      { attacks: Array<{ category: string; prompt: string }> }).attacks.find(a => a.category === 'override')!.prompt

    /** An Anthropic request: a prompt, then one Bash call per result and the results answering them. */
    const toolRequest = (results: string[]) => ({
      model: 'claude-3-opus-20240229',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'Run the checks and report.' },
        { role: 'assistant', content: results.map((_, i) => ({ type: 'tool_use', id: `toolu_p${i}`, name: 'Bash', input: { command: `check ${i}` } })) },
        { role: 'user', content: results.map((r, i) => ({ type: 'tool_result', tool_use_id: `toolu_p${i}`, content: r })) },
      ],
    })
    const post = (payload: unknown) => reqHttp(GATEWAY_PORT, 'POST', '/testprovider/v1/messages', JSON.stringify(payload), { 'x-llm-fw-key': TOKEN })
    const without = (record: object): Record<string, unknown> => {
      const copy: Record<string, unknown> = { ...record }
      delete copy['id']
      delete copy['timestamp']
      return copy
    }

    /** What one request produced besides its response: the dashboard events, oldest first. */
    async function run(payload: unknown) {
      const known = new Set(eventBus.getAll().map(e => e.id))
      const response = await post(payload)
      const events = eventBus.getAll().filter(e => !known.has(e.id)).reverse().map(e => without(e))
      return { response, events }
    }

    /** The same request with the probe off, then on. */
    async function offThenOn(payload: unknown) {
      calls = []
      probe.enabled = false
      const off = await run(payload)
      const forwardedOff = calls.at(-1)!.body
      probe.enabled = true
      const on = await run(payload)
      return { off, on, forwardedOff, forwardedOn: calls.at(-1)!.body }
    }

    beforeEach(() => {
      calls = []
      probe.reset()
    })

    afterEach(() => {
      probe.enabled = false
      probe.reset()
      config.enforcement = 'enforce'
      config.dlp.enabled = false
    })

    it('forwards the body the module returns, and hands it the body DLP has already redacted (FR-012, D2)', async () => {
      config.dlp.enabled = true
      const { off, on, forwardedOff, forwardedOn } = await offThenOn(toolRequest([`install log\ntoken ${GH_TOKEN} was used`, CLEAN]))
      expect(off.response.status).toBe(200)
      expect(on.response.status).toBe(200)
      // With the probe off the upstream gets the DLP-redacted body.
      expect(forwardedOff).toContain('[REDACTED_GITHUB_TOKEN]')
      expect(forwardedOff).not.toContain(GH_TOKEN)
      // The probe was handed exactly that body, and the upstream got the probe's rewrite of it.
      expect(probe.seen).toHaveLength(1)
      expect(probe.seen[0]!.body).toBe(forwardedOff)
      expect(forwardedOn).toBe(markBody(forwardedOff))
      expect(JSON.parse(forwardedOn)[PROBE_FIELD]).toBe('screened')
    })

    it('leaves every dashboard event as it is with the module off (FR-012, D2)', async () => {
      config.dlp.enabled = true
      const { off, on, forwardedOn, forwardedOff } = await offThenOn(toolRequest([`install log\ntoken ${GH_TOKEN} was used`, CLEAN]))
      // Not an empty comparison: DLP puts an event on the bus.
      expect(off.events.length).toBeGreaterThan(0)
      expect(on.events).toEqual(off.events)
      // And the module's body, not the original, is what went upstream.
      expect(forwardedOn).not.toBe(forwardedOff)
    })

    it('puts the module event it returns on the bus the dashboard streams (US4-4)', async () => {
      probe.enabled = true
      const before = new Set(eventBus.getRecentModuleEvents().map(e => e.id))
      const res = await post(toolRequest([CLEAN]))
      expect(res.status).toBe(200)
      expect(probe.emitted).toHaveLength(1)
      expect(before.has(probe.emitted[0]!.id)).toBe(false)
      expect(eventBus.getRecentModuleEvents().find(e => e.id === probe.emitted[0]!.id)).toMatchObject({ moduleId: probe.id, applied: true })
    })

    it('gives the module the body that would go upstream before it answers or observes, and what it returns is what both then see (FR-012)', async () => {
      probe.enabled = true
      const res = await post(toolRequest([CLEAN]))
      expect(res.status).toBe(200)
      expect(probe.seen).toHaveLength(1)
      await vi.waitFor(() => expect(probe.observed).toHaveLength(1))
      const forwarded = calls[0]!.body
      expect(forwarded === markBody(probe.seen[0]!.body), 'the upstream got the probe\'s rewrite of the screened body').toBe(true)
      expect(probe.answered[0] === forwarded, 'respond was asked with the body that goes upstream').toBe(true)
      expect(probe.observed[0] === forwarded, 'observeResponse was given the body that went upstream').toBe(true)
    })

    it('tells the module which tool result DLP redacted and which the scan reached clean (FR-012)', async () => {
      config.dlp.enabled = true
      probe.enabled = true
      const res = await post(toolRequest([`install log\ntoken ${GH_TOKEN} was used`, CLEAN]))
      expect(res.status).toBe(200)
      expect(probe.seen).toHaveLength(1)
      const call = probe.seen[0]!
      expect(call.screening).toBeInstanceOf(Screening)
      const slots = collectTextSlots(JSON.parse(call.body))
      const redacted = slots.findIndex(s => s.kind === 'tool_result' && s.text.includes('[REDACTED_GITHUB_TOKEN]'))
      const clean = slots.findIndex(s => s.kind === 'tool_result' && s.text === CLEAN)
      expect(redacted).toBeGreaterThanOrEqual(0)
      expect(clean).toBeGreaterThanOrEqual(0)
      const { flagged, unreached, all } = call.screening!.flaggedSlots(slots)
      expect(flagged.has(redacted)).toBe(true)
      expect(flagged.has(clean)).toBe(false)
      expect(unreached.size).toBe(0)
      expect(all).toBe(false)
    })

    it('tells the module the caller is on this machine (FR-002)', async () => {
      probe.enabled = true
      await post(toolRequest([CLEAN]))
      expect(probe.seen).toHaveLength(1)
      expect(probe.seen[0]!.remoteAddress).toBeDefined()
      expect(isLoopbackAddr(probe.seen[0]!.remoteAddress)).toBe(true)
      expect(probe.seen[0]!.dryRun).toBe(false)
    })

    it('never runs the module for a request the pipeline refused (FR-012)', async () => {
      probe.enabled = true
      // A request the pipeline passes reaches the module ...
      expect((await post(toolRequest([CLEAN]))).status).toBe(200)
      expect(probe.seen).toHaveLength(1)
      // ... one it refuses does not, and nothing of it goes upstream.
      const res = await post(toolRequest([CLEAN, INJECTION, LINT]))
      expect(res.status).toBe(422)
      expect(probe.seen).toHaveLength(1)
      expect(calls).toHaveLength(1)
    })

    describe('in observe mode', () => {
      beforeEach(() => { config.enforcement = 'observe' })

      it('forwards the screened body, not the module\'s, and still reports what the module did (FR-015, US4-3)', async () => {
        probe.enabled = true
        const res = await post(toolRequest([CLEAN, LINT]))
        expect(res.status).toBe(200)
        expect(probe.seen).toHaveLength(1)
        expect(probe.seen[0]!.dryRun).toBe(true)
        const screened = probe.seen[0]!.body
        expect(calls).toHaveLength(1)
        expect(calls[0]!.body).toBe(screened)
        expect(calls[0]!.body).not.toContain(PROBE_FIELD)
        // The module's event reaches the dashboard marked as not applied.
        expect(eventBus.getRecentModuleEvents().find(e => e.id === probe.emitted[0]!.id)).toMatchObject({ moduleId: probe.id, applied: false })
        // respond and observeResponse see the body that went upstream.
        await vi.waitFor(() => expect(probe.observed).toHaveLength(1))
        expect(probe.answered).toEqual([screened])
        expect(probe.observed).toEqual([screened])
      })

      it('marks the result a blocking scan stopped on as flagged, the ones before it as neither, and the ones after it as unreached (FR-012, audit 4 M1)', async () => {
        probe.enabled = true
        const res = await post(toolRequest([CLEAN, INJECTION, LINT]))
        // Observe mode forwards the request the pipeline would have refused.
        expect(res.status).toBe(200)
        expect(probe.seen).toHaveLength(1)
        const call = probe.seen[0]!
        expect(calls[0]!.body).toBe(call.body)
        const slots = collectTextSlots(JSON.parse(call.body))
        const at = (text: string) => slots.findIndex(s => s.kind === 'tool_result' && s.text === text)
        const [first, second, third] = [at(CLEAN), at(INJECTION), at(LINT)]
        expect([first, second, third].every(i => i >= 0)).toBe(true)
        const { flagged, unreached, all } = call.screening!.flaggedSlots(slots)
        expect(flagged.has(second)).toBe(true)
        expect(flagged.has(first)).toBe(false)
        expect(unreached.has(first)).toBe(false)
        expect(unreached.has(third)).toBe(true)
        expect(flagged.has(third)).toBe(false)
        expect(unreached.has(second)).toBe(false)
        expect(all).toBe(false)
      })
    })
  })
})
