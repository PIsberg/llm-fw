import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayServer } from '../../src/gateway/gateway.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { ModuleManager } from '../../src/modules/registry.js'
import { ToolResultShuntModule } from '../../src/modules/builtin/toolResultShunt.js'
import { renderCondensed } from '../../src/modules/shuntWorker.js'
import { Pipeline } from '../../src/detection/pipeline.js'
import { collectTextSlots } from '../../src/modules/payload.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config, ToolResultShuntConfig } from '../../src/types.js'
import { startFakeWorker, DEFAULT_FACTS, type FakeWorker } from '../modules/fixtures/fakeWorker.js'

// The tool result shunt behind the real gateway: the real module, the real
// detection and DLP, a fake worker on loopback and a stand-in upstream. What
// the unit tests (test/modules/toolResultShunt.test.ts) pin one request at a
// time is pinned here across the listener: what the upstream receives, what
// the worker and the folder of stored originals ever hold, and that switching
// the module on changes nothing the firewall decides (FR-012, SC-009).
// specs/001-tool-result-shunt: US1-1, US1-6, US6-1, US6-4. Needs
// LLM_FW_MODEL_DIR in the environment, as the other gateway suites do.

const TOKEN = 'gw-shunt-test-token'
const GATEWAY_PORT = 18231
/** Starts the marker line of every result that is meant to be flagged, and no clean one. */
const FLAG = 'FLAGGED-RESULT'
/** The marker of one case: if it reaches the worker or a file and the detection did flag that result, a flagged result leaked. */
const markerOf = (tag: string): string => `[${FLAG} ${tag}]`

interface UpstreamCall { path: string; body: string }

function reqHttp(port: number, method: string, path: string, body?: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1', port, method, path,
        headers: { 'content-type': 'application/json', ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...headers },
      },
      res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

/** `n` lines of build output, distinct per tag. */
const lines = (tag: string, n = 400): string[] => Array.from({ length: n }, (_, i) => `${tag} step ${i + 1} finished`)
const output = (tag: string): string => lines(tag).join('\n')
/** Large output with a marker line and then `line` in the middle of it. */
const flaggedWith = (tag: string, line: string): string => {
  const out = lines(tag)
  out.splice(200, 0, markerOf(tag), line)
  return out.join('\n')
}

/** An Anthropic request: a prompt, then one Bash call per result and the results answering them. */
const toolRequest = (results: string[]) => ({
  model: 'claude-3-opus-20240229',
  max_tokens: 64,
  messages: [
    { role: 'user', content: 'Run the checks and report.' },
    { role: 'assistant', content: results.map((_, i) => ({ type: 'tool_use', id: `toolu_s${i}`, name: 'Bash', input: { command: `check ${i}` } })) },
    { role: 'user', content: results.map((r, i) => ({ type: 'tool_result', tool_use_id: `toolu_s${i}`, content: r })) },
  ],
})

/** The tool-result texts of a body, in the order the provider renders them. */
const resultsOf = (body: string): string[] => collectTextSlots(JSON.parse(body)).filter(s => s.kind === 'tool_result').map(s => s.text)

const without = (record: object): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...record }
  delete copy['id']
  delete copy['timestamp']
  return copy
}

describe('Gateway with the tool result shunt', { timeout: 120_000 }, () => {
  const savedDir = process.env.LLM_FW_DIR
  let tempDir: string
  let gateway: GatewayServer
  let upstream: http.Server
  let worker: FakeWorker
  let calls: UpstreamCall[] = []
  let eventBus: EventBus
  let config: Config
  let shunt: ToolResultShuntConfig
  let mod: ToolResultShuntModule

  const folder = () => join(tempDir, 'tool-results')
  /** Names of the files in the folder of stored originals whose content holds `marker`. */
  const folderHolds = (marker: string): string[] => (fs.existsSync(folder())
    ? fs.readdirSync(folder()).filter(name => fs.readFileSync(join(folder(), name), 'utf8').includes(marker))
    : [])
  const workerSaw = (marker: string): boolean => JSON.stringify(worker.received).includes(marker)
  const post = (path: string, payload: unknown) => reqHttp(GATEWAY_PORT, 'POST', path, JSON.stringify(payload), { 'x-llm-fw-key': TOKEN })
  const postMessages = (payload: unknown) => post('/testprovider/v1/messages', payload)

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-gw-shunt-'))
    process.env.LLM_FW_DIR = tempDir
    worker = await startFakeWorker()

    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        calls.push({ path: req.url ?? '', body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
    const upstreamPort = (upstream.address() as { port: number }).port

    const modules = structuredClone(DEFAULT_CONFIG.modules!)
    modules.enabled = true
    modules.toolResultShunt = { ...modules.toolResultShunt!, enabled: false, workerUrl: worker.url, workerModel: 'fake-worker-model' }
    config = {
      ...DEFAULT_CONFIG,
      dlp: { ...DEFAULT_CONFIG.dlp, enabled: true },
      detection: { ...DEFAULT_CONFIG.detection, judgeEnabled: false },
      modules,
      gateway: {
        enabled: true,
        port: GATEWAY_PORT,
        bindHost: '127.0.0.1',
        requireAuth: true,
        authToken: TOKEN,
        defaultProvider: 'testprovider',
        providers: {
          testprovider: { name: 'Test', host: '127.0.0.1', port: upstreamPort, protocol: 'http', auth: 'bearer', apiKey: 'test-key' },
        },
      },
    }
    shunt = modules.toolResultShunt

    eventBus = new EventBus(config.dashboard)
    const moduleManager = new ModuleManager(config)
    mod = moduleManager.getModule('tool-result-shunt') as ToolResultShuntModule
    gateway = new GatewayServer(config, eventBus, undefined, undefined, moduleManager)
    await gateway.init()
    gateway.start()
  })

  afterAll(async () => {
    await gateway?.stop()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await worker.close()
    if (savedDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = savedDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    calls = []
    worker.received.length = 0
    shunt.enabled = true
    config.enforcement = 'enforce'
    fs.rmSync(folder(), { recursive: true, force: true })
  })

  it('condenses a clean large result and forwards its sibling, which holds a secret DLP redacted, whole: one request end to end (US1-1, US6-3)', async () => {
    const clean = output('end to end')
    const secret = flaggedWith('end to end secret', `token ghp_${'a'.repeat(36)}`)
    const res = await postMessages(toolRequest([clean, secret]))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)

    const [first, second] = resultsOf(calls[0]!.body)
    // The clean result reaches the upstream condensed, and the file at the stated path is the exact original.
    const path = mod.store.pathFor(clean)
    expect(first).toBe(renderCondensed(clean, DEFAULT_FACTS, path))
    expect(fs.readFileSync(path, 'utf8')).toBe(clean)
    expect(worker.received).toHaveLength(1)

    // The one DLP redacted is forwarded whole as redacted: not condensed, not sent to the worker, not stored.
    expect(second).toContain('[REDACTED_GITHUB_TOKEN]')
    expect(second).toContain(FLAG)
    expect(second!.startsWith('[llm-fw: tool output condensed')).toBe(false)
    expect(workerSaw(FLAG)).toBe(false)
    expect(folderHolds(FLAG)).toEqual([])
    expect(fs.readdirSync(folder()).filter(name => name.endsWith('.txt'))).toEqual([basename(path)])
  })

  // GHSA-83jp-cppw-c3v6 made detection read Responses tool output, so the
  // shunt treats it like any other result: condensed when the scan passed it,
  // forwarded whole when the scan flagged it (US1-6, FR-012, FR-016).
  it('condenses a large OpenAI Responses function_call_output the scan passed, and forwards one DLP redacted whole', async () => {
    const responses = (clean: string, secret: string) => ({
      model: 'gpt-5',
      input: [
        { role: 'user', content: 'Run the checks and report.' },
        { type: 'function_call', call_id: 'call_resp_1', name: 'shell', arguments: JSON.stringify({ command: ['npm', 'test'] }) },
        { type: 'function_call_output', call_id: 'call_resp_1', output: clean },
        { type: 'function_call', call_id: 'call_resp_2', name: 'shell', arguments: JSON.stringify({ command: ['npm', 'run', 'lint'] }) },
        { type: 'function_call_output', call_id: 'call_resp_2', output: secret },
      ],
    })
    const outputsOf = (body: string): string[] =>
      (JSON.parse(body) as { input: Array<{ type?: string; output?: string }> }).input
        .filter(i => i.type === 'function_call_output').map(i => i.output!)

    const clean = output('responses output')
    const secret = flaggedWith('responses secret', `token ghp_${'b'.repeat(36)}`)
    for (let i = 0; i < 2; i++) {
      const res = await post('/testprovider/v1/responses', responses(clean, secret))
      expect(res.status).toBe(200)
    }
    expect(calls).toHaveLength(2)
    const path = mod.store.pathFor(clean)
    for (const call of calls) {
      expect(call.path).toBe('/v1/responses')
      const [first, second] = outputsOf(call.body)
      expect(first).toBe(renderCondensed(clean, DEFAULT_FACTS, path))
      expect(second).toContain('[REDACTED_GITHUB_TOKEN]')
      expect(second!.startsWith('[llm-fw: tool output condensed')).toBe(false)
    }
    // Byte-identical on the repeat, from one worker call.
    expect(calls[1]!.body).toBe(calls[0]!.body)
    expect(fs.readFileSync(path, 'utf8')).toBe(clean)
    expect(worker.received).toHaveLength(1)
    expect(workerSaw(FLAG)).toBe(false)
    expect(folderHolds(FLAG)).toEqual([])
  })

  describe('the firewall decides the same with the module off and on (US6-1, US6-4, SC-009)', { timeout: 900_000 }, () => {
    type Mode = 'enforce' | 'observe'
    interface Case { label: string; marker: string; kind: 'secret' | 'injection' | 'clean'; mode: Mode; payload: unknown }
    const attacks = (JSON.parse(fs.readFileSync(new URL('../detection/fixtures/corpus.json', import.meta.url), 'utf8')) as
      { attacks: Array<{ category: string; prompt: string }> }).attacks.slice(0, 30)

    // Candidates for the results the detection flags: a secret DLP finds, and corpus injections it refuses (enforce) or only warns about
    // (observe). The detection does not catch every corpus attack once it sits in 400 lines of build output, so which candidates it
    // did flag is read from the module-off run. Results it does not: plain build output. Every text is distinct, so no request is
    // served from a cache of an earlier one.
    const cases: Case[] = [
      ...Array.from({ length: 25 }, (_, i): Case => ({
        label: `secret ${i}`, marker: markerOf(`secret ${i}`), kind: 'secret', mode: 'enforce',
        payload: toolRequest([flaggedWith(`secret ${i}`, `export GITHUB_TOKEN=ghp_${String(i).padStart(36, 'a')}`)]),
      })),
      ...attacks.map((a, i): Case => ({
        label: `injection ${i} (enforce)`, marker: markerOf(`injection enforce ${i}`), kind: 'injection', mode: 'enforce',
        payload: toolRequest([flaggedWith(`injection enforce ${i}`, a.prompt)]),
      })),
      ...attacks.map((a, i): Case => ({
        label: `injection ${i} (observe)`, marker: markerOf(`injection observe ${i}`), kind: 'injection', mode: 'observe',
        payload: toolRequest([flaggedWith(`injection observe ${i}`, a.prompt)]),
      })),
      ...Array.from({ length: 50 }, (_, i): Case => ({
        label: `clean ${i}`, marker: '', kind: 'clean', mode: 'enforce',
        payload: toolRequest([output(`clean ${i}`)]),
      })),
    ]

    it('gives the same status and the same events for at least 50 flagged and 50 unflagged requests, runs the detection once per request, and lets no flagged result reach the worker or the folder', async () => {
      const run = vi.spyOn(Pipeline.prototype, 'run')
      try {
        /** One request: what the firewall answered, what it put on the bus besides module events, how often it ran the pipeline, what went upstream. */
        async function once(c: Case, moduleOn: boolean) {
          shunt.enabled = moduleOn
          config.enforcement = c.mode
          calls = []
          run.mockClear()
          const known = new Set(eventBus.getAll().map(e => e.id))
          const res = await postMessages(c.payload)
          const events = eventBus.getAll().filter(e => !known.has(e.id)).reverse().map(without)
          return { status: res.status, events, runs: run.mock.calls.length, forwarded: calls.at(-1)?.body }
        }

        const statusDiffers: string[] = []
        const eventsDiffer: string[] = []
        const notOneRun: string[] = []
        const flaggedBodyDiffers: string[] = []
        const cleanNotCondensed: string[] = []
        const cleanFlagged: string[] = []
        const flagged: string[] = []
        const flaggedMarkers: string[] = []
        const secretsNotFlagged: string[] = []
        const clean: string[] = []

        for (const c of cases) {
          const off = await once(c, false)
          const on = await once(c, true)
          if (on.status !== off.status) statusDiffers.push(c.label)
          if (JSON.stringify(on.events) !== JSON.stringify(off.events)) eventsDiffer.push(c.label)
          if (off.runs !== 1 || on.runs !== 1) notOneRun.push(`${c.label}: off ${off.runs}, on ${on.runs}`)

          // The detection's own verdict on the request, read from the module-off run: it refused, warned or redacted something, or it did not.
          const wasFlagged = off.status !== 200 || off.events.length > 0
          if (c.kind === 'clean') {
            clean.push(c.label)
            if (wasFlagged) cleanFlagged.push(c.label)
            // Module off: the body goes through as sent. On: the result reaches the upstream condensed.
            expect(off.forwarded, c.label).toBe(JSON.stringify(c.payload))
            if (!on.forwarded || !resultsOf(on.forwarded).every(r => r.startsWith('[llm-fw: tool output condensed'))) cleanNotCondensed.push(c.label)
          } else if (wasFlagged) {
            flagged.push(c.label)
            flaggedMarkers.push(c.marker)
            // The module leaves everything of a flagged request as it is with the module off.
            if (on.forwarded !== off.forwarded) flaggedBodyDiffers.push(c.label)
          } else if (c.kind === 'secret') {
            secretsNotFlagged.push(c.label)
          }
        }

        // Neither population is empty by accident: the sample is what the success criterion asks for.
        expect(flagged.length, 'requests whose large results the detection flagged').toBeGreaterThanOrEqual(50)
        expect(clean.length, 'requests whose results it did not').toBeGreaterThanOrEqual(50)
        expect(cleanFlagged, 'clean results the detection flagged after all').toEqual([])
        expect(secretsNotFlagged, 'secrets the detection let through').toEqual([])

        expect(statusDiffers, 'requests whose status differs between module off and on').toEqual([])
        expect(eventsDiffer, 'requests whose non-module events differ between module off and on').toEqual([])
        expect(notOneRun, 'requests that ran the detection pipeline other than once, off or on').toEqual([])
        expect(flaggedBodyDiffers, 'flagged requests forwarded differently with the module on').toEqual([])

        // The module did its work on the results that were safe to condense ...
        expect(cleanNotCondensed, 'clean results not condensed with the module on').toEqual([])
        expect(worker.received.length).toBeGreaterThanOrEqual(clean.length)
        // ... and the text of a flagged result went nowhere: not to the worker, not to a file.
        expect(flaggedMarkers.filter(workerSaw), 'flagged results that reached the worker').toEqual([])
        expect(flaggedMarkers.filter(marker => folderHolds(marker).length > 0), 'flagged results found in a stored file').toEqual([])
        expect(workerSaw('ghp_')).toBe(false)
        expect(folderHolds('ghp_')).toEqual([])
      } finally {
        run.mockRestore()
      }
    })
  })
})
