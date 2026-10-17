import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import fs from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { ModuleManager } from '../../src/modules/registry.js'
import { ToolResultShuntModule, eligibility } from '../../src/modules/builtin/toolResultShunt.js'
import { Screening } from '../../src/modules/screening.js'
import { collectTextSlots } from '../../src/modules/payload.js'
import { renderCondensed, numberLines, WORKER_INSTRUCTIONS } from '../../src/modules/shuntWorker.js'
import { estimateTokens } from '../../src/modules/tokens.js'
import type { CapturedResponse } from '../../src/modules/responseTap.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config, ToolResultShuntConfig } from '../../src/types.js'
import { startFakeWorker, chatAnswer, promptTokensOf, DEFAULT_FACTS, type FakeWorker, type FakeWorkerReply } from './fixtures/fakeWorker.js'

// Slice S1 of the tool result shunt: the config key and the registration.
// specs/001-tool-result-shunt/data-model.md "Config" is the table asserted
// here. test/modules/builtins.test.ts already walks BUILTINS for the
// LLM_FW_TOOL_RESULT_SHUNT_ENABLED switch and the warm options (US4-2, US4-5).

describe('modules.toolResultShunt defaults', () => {
  const shunt = () => DEFAULT_CONFIG.modules!.toolResultShunt!

  it('is off by default (FR-001, US4-1)', () => {
    expect(shunt().enabled).toBe(false)
  })

  it('carries the size thresholds and limits of data-model.md "Config" (FR-002, FR-008, FR-024, FR-025)', () => {
    const { enabled: _enabled, tools: _tools, ...options } = shunt()
    expect(options).toEqual({
      minLines: 350,
      minChars: 20000,
      maxInputChars: 200000,
      waitMs: 15000,
      workerUrl: '',
      workerModel: '',
      retentionHours: 24,
      maxStoreMB: 200,
    })
  })

  it('names no worker until the operator sets one (FR-011)', () => {
    expect(shunt().workerUrl).toBe('')
    expect(shunt().workerModel).toBe('')
  })

  it('lists the eligible tools of data-model.md "Config" (FR-003)', () => {
    expect([...shunt().tools].sort()).toEqual([
      'Bash', 'BashOutput', 'Glob', 'Grep', 'LS', 'PowerShell',
      'exec_command', 'glob', 'list_directory', 'run_shell_command', 'search_file_content', 'shell',
    ].sort())
  })

  it('shares no tool name with the truncator skipTools, so no file-reading tool is eligible (FR-003, US1-7)', () => {
    const skip = DEFAULT_CONFIG.modules!.toolResultTruncate!.skipTools
    expect(skip.length).toBeGreaterThan(0)
    const shared = shunt().tools.filter(name => skip.includes(name))
    expect(shared).toEqual([])
    // The same check the module will make: a name ending in `__` plus a skipped name is a file read too.
    const mcpShared = shunt().tools.filter(name => skip.some(s => name.endsWith(`__${s}`)))
    expect(mcpShared).toEqual([])
  })

  it('has no duplicate tool names', () => {
    const { tools } = shunt()
    expect(new Set(tools).size).toBe(tools.length)
  })
})

describe('ModuleManager registration of the tool result shunt', () => {
  it('registers tool-result-shunt, disabled (US4-1)', () => {
    const mod = new ModuleManager(structuredClone(DEFAULT_CONFIG) as Config).getModule('tool-result-shunt')
    expect(mod).toBeDefined()
    expect(mod!.id).toBe('tool-result-shunt')
    expect(mod!.name).toBe('Tool Result Shunt')
    expect(mod!.enabled).toBe(false)
  })

  it('registers it disabled when the manager is built without a config (US4-1)', () => {
    const mod = new ModuleManager().getModule('tool-result-shunt')
    expect(mod).toBeDefined()
    expect(mod!.enabled).toBe(false)
  })

  it('creates the config slot from the defaults for a config that predates it, and hands the module that live slot (US4-2)', () => {
    const config = { ...structuredClone(DEFAULT_CONFIG), modules: { enabled: true, tokenPruner: { enabled: true } } } as unknown as Config
    const mgr = new ModuleManager(config)
    const slot = config.modules!.toolResultShunt
    expect(slot).toEqual(DEFAULT_CONFIG.modules!.toolResultShunt)
    // Flipping the live slot reaches the running module without a restart.
    slot!.enabled = true
    expect(mgr.getModule('tool-result-shunt')!.enabled).toBe(true)
  })

  it('is switched on and off through the manager, as the dashboard does (FR-001, US4-2)', () => {
    const mgr = new ModuleManager(structuredClone(DEFAULT_CONFIG) as Config)
    expect(mgr.setModuleEnabled('tool-result-shunt', true)).toBe(true)
    expect(mgr.getModule('tool-result-shunt')!.enabled).toBe(true)
    expect(mgr.setModuleEnabled('tool-result-shunt', false)).toBe(true)
    expect(mgr.getModule('tool-result-shunt')!.enabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Slice S3 and S4 meet in the module (T015): condensing a tool result. Every
// test drives ModuleManager.transformScreened, the pass the proxy and the
// gateway run after detection and DLP, against a fake worker on loopback and a
// scratch LLM_FW_DIR, so nothing reaches a model or the operator's folder.
// specs/001-tool-result-shunt: contracts/interfaces.md section 1 is the
// condensed result, data-model.md "Eligibility" and "Remembered outcome" the
// rules. Flags are T017's: here every result was scanned and none flagged.
// ---------------------------------------------------------------------------

const BASE_CTX: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const HOUR = 3_600_000

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** The key a decided outcome is remembered and stored under (data-model.md "Remembered outcome"). */
const keyOf = (toolName: string, text: string): string => sha256(`${toolName}\0${text}`)

/** `n` lines of build output, distinct per tag. */
const output = (tag: string, n = 400): string => Array.from({ length: n }, (_, i) => `${tag} step ${i + 1} finished`).join('\n')
/** `n` short lines. */
const rows = (n: number): string => Array.from({ length: n }, (_, i) => `row ${i + 1}`).join('\n')

type Out = string | Array<{ type: 'text'; text: string }>
interface Call { id: string; name: string; input: unknown; out: Out }
const call = (id: string, name: string, input: unknown, out: Out): Call => ({ id, name, input, out })
const bash = (id: string, command: string, out: Out): Call => call(id, 'Bash', { command }, out)

/** An assistant turn that makes the calls, and the user turn that carries their results (Anthropic Messages). */
const turn = (calls: Call[]) => [
  { role: 'assistant', content: calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) },
  { role: 'user', content: calls.map(c => ({ type: 'tool_result', tool_use_id: c.id, content: c.out })) },
]
const request = (...turns: unknown[][]) => ({
  model: 'claude-sonnet-5-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'run the checks' }, ...turns.flat()],
})
/** The same calls as an OpenAI chat request: tool_calls on the assistant message, one `role: 'tool'` message per result. */
const chatRequest = (calls: Array<{ id: string; name: string; args: unknown; out: string }>) => ({
  model: 'gpt-5',
  messages: [
    { role: 'user', content: 'run the checks' },
    { role: 'assistant', content: null, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
    ...calls.map(c => ({ role: 'tool', tool_call_id: c.id, content: c.out })),
  ],
})

/** The tool-result texts of a request, in the order the provider renders them. */
const resultsOf = (body: unknown): string[] => collectTextSlots(body).filter(s => s.kind === 'tool_result').map(s => s.text)

/** A scan that reached every text of the body and flagged none: what a clean request leaves in the record. */
function scannedScreening(body: string): Screening {
  const screening = new Screening()
  for (const slot of collectTextSlots(JSON.parse(body))) screening.noteItemScanned(slot.text)
  return screening
}

/** A streamed Anthropic response, as the proxy captures it. */
const sse = (...events: unknown[]): CapturedResponse => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: Buffer.from(events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')),
})

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

describe('eligibility (data-model.md "Eligibility", FR-002, FR-003)', () => {
  const cfg = (over: Partial<ToolResultShuntConfig> = {}): ToolResultShuntConfig => ({ ...structuredClone(DEFAULT_CONFIG.modules!.toolResultShunt!), ...over })
  const LOCAL = '127.0.0.1'
  const BIG = rows(400)
  const ask = (name: string | undefined, input: unknown, text: string, over: Partial<ToolResultShuntConfig> = {}, remote: string | null = LOCAL) =>
    eligibility(name, input, text, cfg(over), remote ?? undefined)

  it('is null for a known, included tool, an unranged call, a result over the threshold and a caller on this machine', () => {
    expect(ask('Bash', { command: 'npm test' }, BIG)).toBeNull()
    expect(ask('run_shell_command', { command: 'npm test' }, BIG)).toBeNull()
    expect(ask('shell', JSON.stringify({ command: ['npm', 'test'] }), BIG)).toBeNull()
  })

  it('gives tool-unknown when the call that produced the result is not known, before anything else (step 1)', () => {
    expect(ask(undefined, { command: 'npm test' }, BIG)).toBe('tool-unknown')
    // Not excluded, not ranged, not small, not remote: unknown still wins, whatever else is wrong.
    expect(ask(undefined, { offset: 1 }, 'x', {}, '10.0.0.5')).toBe('tool-unknown')
  })

  it('gives excluded-tool for a tool that is not in the list, a file read among them by default (step 2, US1-7)', () => {
    for (const name of ['Read', 'ctx_read', 'Edit', 'WebFetch', 'bash']) expect(ask(name, { file_path: '/a/b.ts' }, BIG), name).toBe('excluded-tool')
  })

  it('matches a tool by its name or by the name after `__`, as the truncator\'s skipTools does (FR-003)', () => {
    expect(ask('mcp__shell__Bash', { command: 'ls' }, BIG)).toBeNull()
    expect(ask('mcp__a__b__Grep', { pattern: 'x' }, BIG)).toBeNull()
    expect(ask('mcp__fs__Read', { file_path: '/a/b.ts' }, BIG)).toBe('excluded-tool')
    // The prefix has to end in `__`: a longer name that merely ends in a listed one is another tool.
    expect(ask('MyBash', { command: 'ls' }, BIG)).toBe('excluded-tool')
    expect(ask('mcp_Bash', { command: 'ls' }, BIG)).toBe('excluded-tool')
  })

  it('takes a file-reading tool the operator includes, and still leaves a ranged read of it whole (step 3, US1-7)', () => {
    const include = { tools: [...DEFAULT_CONFIG.modules!.toolResultShunt!.tools, 'Read'] }
    expect(ask('Read', { file_path: '/a/b.ts' }, BIG, include)).toBeNull()
    for (const key of ['offset', 'limit', 'view_range', 'head', 'tail', 'start_line', 'end_line']) {
      expect(ask('Read', { file_path: '/a/b.ts', [key]: 5 }, BIG, include), key).toBe('excluded-tool')
    }
    // A provider that sends the arguments as a JSON string is read the same way.
    expect(ask('Read', JSON.stringify({ file_path: '/a/b.ts', limit: 50 }), BIG, include)).toBe('excluded-tool')
    expect(ask('Read', JSON.stringify({ file_path: '/a/b.ts' }), BIG, include)).toBeNull()
  })

  it('never takes a read that names a stored original, so the way back is not condensed again (step 3, US1-7)', () => {
    const include = { tools: [...DEFAULT_CONFIG.modules!.toolResultShunt!.tools, 'Read'] }
    const name = `${'0123456789abcdef'.repeat(4)}.txt`
    const path = join('home', 'u', '.llm-fw', 'tool-results', name)
    expect(ask('Read', { file_path: path }, BIG, include)).toBe('excluded-tool')
    expect(ask('Bash', { command: `cat ${path}` }, BIG)).toBe('excluded-tool')
    expect(ask('Bash', JSON.stringify({ command: `sed -n 1,400p ${path}` }), BIG)).toBe('excluded-tool')
    // Only the real shape counts: 63 hex digits, 64 without `.txt` and 64 that are not hex are other files.
    expect(ask('Bash', { command: `cat ${'a'.repeat(63)}.txt` }, BIG)).toBeNull()
    expect(ask('Bash', { command: `cat ${'a'.repeat(64)}` }, BIG)).toBeNull()
    expect(ask('Bash', { command: `cat ${'g'.repeat(64)}.txt` }, BIG)).toBeNull()
  })

  it('gives excluded-tool for a ranged call before it looks at the size (step 3 before step 4)', () => {
    const include = { tools: [...DEFAULT_CONFIG.modules!.toolResultShunt!.tools, 'Read'] }
    expect(ask('Read', { file_path: '/a/b.ts', offset: 10 }, 'tiny', include)).toBe('excluded-tool')
    expect(ask('Read', { file_path: '/a/b.ts' }, 'tiny', include)).toBe('below-threshold')
  })

  it('draws the size line at exactly minLines and exactly minChars (step 4, spec Edge Cases)', () => {
    expect(ask('Bash', {}, rows(350))).toBeNull()
    expect(ask('Bash', {}, rows(349))).toBe('below-threshold')
    expect(ask('Bash', {}, 'x'.repeat(20_000))).toBeNull()
    expect(ask('Bash', {}, 'x'.repeat(19_999))).toBe('below-threshold')
    // Either measure is enough, and both come from the live config.
    expect(ask('Bash', {}, rows(3), { minLines: 3 })).toBeNull()
    expect(ask('Bash', {}, rows(2), { minLines: 3 })).toBe('below-threshold')
    expect(ask('Bash', {}, 'x'.repeat(50), { minChars: 50 })).toBeNull()
    expect(ask('Bash', {}, 'x'.repeat(49), { minChars: 50 })).toBe('below-threshold')
  })

  it('counts a final newline as ending a line, not starting one (data-model.md "Size")', () => {
    expect(ask('Bash', {}, `${rows(350)}\n`)).toBeNull()
    expect(ask('Bash', {}, `${rows(349)}\n`)).toBe('below-threshold')
  })

  it('gives too-large above maxInputChars and not at it (step 5)', () => {
    expect(ask('Bash', {}, 'x'.repeat(200_000))).toBeNull()
    expect(ask('Bash', {}, 'x'.repeat(200_001))).toBe('too-large')
    expect(ask('Bash', {}, 'x'.repeat(30_000), { maxInputChars: 30_000 })).toBeNull()
    expect(ask('Bash', {}, 'x'.repeat(30_001), { maxInputChars: 30_000 })).toBe('too-large')
  })

  it('gives remote-client for a caller that is not on this machine, and none for 127.x, ::1 and the mapped form (step 6, US2-7)', () => {
    for (const addr of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) expect(ask('Bash', {}, BIG, {}, addr), addr).toBeNull()
    for (const addr of ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5', '2001:db8::1', null]) expect(ask('Bash', {}, BIG, {}, addr), String(addr)).toBe('remote-client')
  })

  it('reports the first step that fails, in order: size before remote, too-large before remote (steps 4 to 6)', () => {
    expect(ask('Bash', {}, 'tiny', {}, '10.0.0.5')).toBe('below-threshold')
    expect(ask('Bash', {}, 'x'.repeat(200_001), {}, '10.0.0.5')).toBe('too-large')
    expect(ask('Bash', {}, BIG, {}, '10.0.0.5')).toBe('remote-client')
    // An excluded tool is reported as that even when the result is also small and the caller remote.
    expect(ask('Read', {}, 'tiny', {}, '10.0.0.5')).toBe('excluded-tool')
  })
})

describe('ToolResultShuntModule: condensing a tool result', { timeout: 60_000 }, () => {
  const savedEnv = { dir: process.env.LLM_FW_DIR, format: process.env.LLM_FW_LOG_FORMAT, level: process.env.LLM_FW_LOG_LEVEL }

  let root: string
  let worker: FakeWorker
  /** What the fake worker answers; undefined is the default fact list. */
  let reply: (body: unknown) => FakeWorkerReply | undefined
  let warn: MockInstance<typeof console.warn>

  /** A module manager on a config of its own, the shunt on and pointed at the fake worker; the folder is shared through LLM_FW_DIR. */
  function boot(over: Partial<ToolResultShuntConfig> = {}) {
    const config = structuredClone(DEFAULT_CONFIG) as Config
    Object.assign(config.modules!.toolResultShunt!, { enabled: true, workerUrl: worker.url, workerModel: 'fake-worker-model', ...over })
    const mgr = new ModuleManager(config)
    return { config, mgr, shunt: config.modules!.toolResultShunt!, mod: mgr.getModule('tool-result-shunt') as ToolResultShuntModule }
  }
  let m: ReturnType<typeof boot>

  /** Run one request through the post-screening pass, every text scanned and none flagged, the caller on this machine. */
  async function send(payload: unknown, ctx: Partial<GatewayModuleContext> = {}, mgr: ModuleManager = m.mgr) {
    const input = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const res = await mgr.transformScreened(input, { ...BASE_CTX, screening: scannedScreening(input), remoteAddress: '127.0.0.1', ...ctx })
    return { ...res, input, results: resultsOf(JSON.parse(res.body)) }
  }

  const folder = () => join(root, 'tool-results')
  const files = (ext: string) => (fs.existsSync(folder()) ? fs.readdirSync(folder()).filter(f => f.endsWith(ext)) : [])
  /** The warnings the module logged, as parsed records. */
  const shuntWarnings = (): Array<Record<string, unknown>> => warn.mock.calls
    .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown> } catch { return {} } })
    .filter(record => record['scope'] === 'tool-result-shunt')

  /** Facts that differ by call, so a result decided again reads differently from the first time. */
  const countingFacts = (): ((body: unknown) => FakeWorkerReply) => {
    let n = 0
    return body => ({ json: chatAnswer(`facts of call ${++n}: 3 tests failed`, { prompt_tokens: promptTokensOf(body), completion_tokens: 12 }) })
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shunt-module-'))
    process.env.LLM_FW_DIR = root
    process.env.LLM_FW_LOG_FORMAT = 'json'
    delete process.env.LLM_FW_LOG_LEVEL
    reply = () => undefined
    worker = await startFakeWorker(body => reply(body))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    m = boot()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await worker.close()
    for (const [key, value] of [['LLM_FW_DIR', savedEnv.dir], ['LLM_FW_LOG_FORMAT', savedEnv.format], ['LLM_FW_LOG_LEVEL', savedEnv.level]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** A request the module is known to condense, to show a negative case is not passing because the module is off or broken. */
  async function expectLive(): Promise<void> {
    const text = output('control')
    const res = await send(request(turn([bash('toolu_control', 'npm test', text)])), { dryRun: true })
    expect(res.results[0], 'a control result over the threshold should be condensed').not.toBe(text)
  }

  describe('the condensed result (US1-1, US1-3, US2-1, US2-4)', () => {
    it('replaces a result at the threshold with the text of contracts section 1, at most half its tokens, and stores the exact original (US1-1, US2-4)', async () => {
      const text = output('build')
      const res = await send(request(turn([bash('toolu_1', 'npm test', text)])))
      const path = m.mod.store.pathFor(text)

      expect(res.modified).toBe(true)
      expect(res.results).toEqual([renderCondensed(text, DEFAULT_FACTS, path)])
      expect(estimateTokens(res.results[0]!)).toBeLessThanOrEqual(0.5 * estimateTokens(text))
      // The path is absolute, inside the folder under the data directory, and named by the content.
      expect(isAbsolute(path)).toBe(true)
      expect(path).toBe(join(root, 'tool-results', `${sha256(text)}.txt`))
      // The file is there before the request is forwarded, complete and byte-identical.
      expect(fs.readFileSync(path).equals(Buffer.from(text, 'utf8'))).toBe(true)
    })

    it('forwards a result below the threshold byte-identical, beside one that is condensed (US1-3)', async () => {
      const small = rows(349)
      const big = output('big')
      const res = await send(request(turn([bash('toolu_1', 'ls', small), bash('toolu_2', 'npm test', big)])))
      expect(res.results[0]).toBe(small)
      expect(res.results[1]).not.toBe(big)
      expect(worker.received).toHaveLength(1)
      expect(files('.txt')).toEqual([`${sha256(big)}.txt`])
    })

    it('condenses a result of exactly minLines lines and leaves one line fewer whole (spec Edge Cases)', async () => {
      const at = rows(350)
      const under = rows(349)
      const res = await send(request(turn([bash('toolu_1', 'ls', at), bash('toolu_2', 'ls -a', under)])))
      expect(res.results[0]).toBe(renderCondensed(at, DEFAULT_FACTS, m.mod.store.pathFor(at)))
      expect(res.results[1]).toBe(under)
    })

    it('condenses a result of exactly minChars characters and leaves one character fewer whole (spec Edge Cases)', async () => {
      const at = 'x'.repeat(20_000)
      const under = 'y'.repeat(19_999)
      const res = await send(request(turn([bash('toolu_1', 'cat a', at), bash('toolu_2', 'cat b', under)])))
      expect(res.results[0]).toBe(renderCondensed(at, DEFAULT_FACTS, m.mod.store.pathFor(at)))
      expect(res.results[1]).toBe(under)
    })

    it('cites line numbers of the stored file: the lines a condensed result points at hold the original\'s exact lines (US2-1)', async () => {
      reply = body => ({ json: chatAnswer('3 tests failed, see lines 12-14. Exit code 1.', { prompt_tokens: promptTokensOf(body), completion_tokens: 14 }) })
      const text = output('suite')
      const res = await send(request(turn([bash('toolu_1', 'npm test', text)])))
      const condensed = res.results[0]!
      const range = /lines (\d+)-(\d+)/.exec(condensed)
      expect(range).not.toBeNull()
      const [from, to] = [Number(range![1]), Number(range![2])]
      const stored = fs.readFileSync(m.mod.store.pathFor(text), 'utf8').split('\n')
      expect(stored.slice(from - 1, to)).toEqual(text.split('\n').slice(from - 1, to))
      expect(stored.slice(from - 1, to)).toEqual(['suite step 12 finished', 'suite step 13 finished', 'suite step 14 finished'])
    })

    it('sends the worker only the result and the fixed instructions, and no credential or other part of the request (US3-6, FR-010)', async () => {
      const text = output('private')
      const body = request(turn([bash('toolu_1', 'npm test', text), bash('toolu_2', 'ls', rows(10))]))
      body.messages[0] = { role: 'user', content: 'USER-PROMPT-MARK' }
      ;(body as Record<string, unknown>)['system'] = 'SYSTEM-PROMPT-MARK'
      await send(body, { headers: { 'x-api-key': 'sk-ant-LEAKED-KEY', authorization: 'Bearer LEAKED-BEARER' } })

      expect(worker.received).toHaveLength(1)
      const sent = worker.received[0]!
      expect(sent.body).toMatchObject({ messages: [{ role: 'system', content: WORKER_INSTRUCTIONS }, { role: 'user', content: numberLines(text) }] })
      const everything = JSON.stringify(sent)
      for (const secret of ['USER-PROMPT-MARK', 'SYSTEM-PROMPT-MARK', 'LEAKED-KEY', 'LEAKED-BEARER', 'row 1']) expect(everything.includes(secret), secret).toBe(false)
      expect(sent.headers['authorization']).toBeUndefined()
      expect(sent.headers['x-api-key']).toBeUndefined()
    })
  })

  describe('file-reading tools (US1-7)', () => {
    const read = (id: string, input: Record<string, unknown>, out: string) => call(id, 'Read', input, out)

    it('leaves a file read whole by default and condenses it once the operator includes the tool (US1-7)', async () => {
      const text = output('file')
      const body = request(turn([read('toolu_1', { file_path: '/repo/src/a.ts' }, text)]))
      expect((await send(body)).results).toEqual([text])
      expect(worker.received).toHaveLength(0)

      m.shunt.tools = [...m.shunt.tools, 'Read']
      const res = await send(body)
      expect(res.results).toEqual([renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text))])
    })

    it('leaves a ranged read of an included tool whole (US1-7)', async () => {
      m.shunt.tools = [...m.shunt.tools, 'Read']
      const ranged = output('ranged')
      const whole = output('whole')
      const res = await send(request(turn([
        read('toolu_1', { file_path: '/repo/src/a.ts', offset: 100, limit: 400 }, ranged),
        read('toolu_2', { file_path: '/repo/src/b.ts' }, whole),
      ])))
      expect(res.results[0]).toBe(ranged)
      expect(res.results[1]).toBe(renderCondensed(whole, DEFAULT_FACTS, m.mod.store.pathFor(whole)))
    })

    it('never condenses a read of a stored original, though the same text is condensed under the call that produced it', async () => {
      const text = output('original')
      const path = m.mod.store.pathFor(text)
      const res = await send(request(turn([
        bash('toolu_1', 'npm test', text),
        bash('toolu_2', `cat ${path}`, text),
      ])))
      expect(res.results[0]).toBe(renderCondensed(text, DEFAULT_FACTS, path))
      // The way back reads the file whole, however large it is.
      expect(res.results[1]).toBe(text)
    })
  })

  describe('request formats and thread continuations (US1-5, US1-6, FR-016)', () => {
    it('condenses a result sent as Anthropic text parts, and one in an OpenAI chat tool message (US1-6)', async () => {
      const parts = output('parts')
      const chat = output('chat')
      const anthropic = await send(request(turn([bash('toolu_1', 'npm test', [{ type: 'text', text: parts }])])))
      expect(anthropic.results).toEqual([renderCondensed(parts, DEFAULT_FACTS, m.mod.store.pathFor(parts))])

      const openai = await send(chatRequest([{ id: 'call_1', name: 'shell', args: { command: ['npm', 'test'] }, out: chat }]))
      expect(openai.results).toEqual([renderCondensed(chat, DEFAULT_FACTS, m.mod.store.pathFor(chat))])
      expect(worker.received).toHaveLength(2)
    })

    it('learns the tool of a thread continuation from the response that made the call, and forwards it whole until then (US1-5)', async () => {
      const text = output('thread')
      const continuation = {
        model: 'claude-sonnet-5-5', stream: true,
        thread: { type: 'continue', previous_message_id: 'msg_1' },
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_thread', content: text }] }],
      }
      // The call is not in the request: the tool is unknown, and the result is forwarded whole.
      expect((await send(continuation)).results).toEqual([text])
      expect(worker.received).toHaveLength(0)

      m.mgr.observeResponse('{}', BASE_CTX, sse(
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_thread', name: 'Bash', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ))
      // Unknown was not a decision to remember: the same request is condensed now.
      const res = await send(continuation)
      expect(res.results).toEqual([renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text))])
    })

    it('reads the arguments of a call learned from a response, so a ranged read of a thread continuation stays whole (US1-5, US1-7)', async () => {
      m.shunt.tools = [...m.shunt.tools, 'Read']
      m.mgr.observeResponse('{}', BASE_CTX, sse(
        { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', content: [] } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_ranged', name: 'Read', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/repo/a.ts","offset":10,"limit":400}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_unranged', name: 'Read', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/repo/b.ts"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_stop' },
      ))
      const ranged = output('ranged')
      const unranged = output('unranged')
      const res = await send({
        model: 'claude-sonnet-5-5', stream: true,
        thread: { type: 'continue', previous_message_id: 'msg_2' },
        messages: [{ role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_ranged', content: ranged },
          { type: 'tool_result', tool_use_id: 'toolu_unranged', content: unranged },
        ] }],
      })
      expect(res.results[0]).toBe(ranged)
      expect(res.results[1]).toBe(renderCondensed(unranged, DEFAULT_FACTS, m.mod.store.pathFor(unranged)))
    })
  })

  describe('one decision per result (FR-006, US1-4, SC-004)', () => {
    it('forwards a history resent over 10 turns byte-identical, asking the worker once and storing one file per distinct result', async () => {
      // Turn 7 repeats turn 3's output under another call: the same original, so the same outcome.
      const text = (k: number) => output(k === 7 ? 'turn 3' : `turn ${k}`)
      const turns = Array.from({ length: 10 }, (_, k) => turn([bash(`toolu_${k + 1}`, `step ${k + 1}`, text(k + 1))]))
      const outs: Array<{ messages: unknown[] }> = []
      for (let n = 1; n <= 10; n++) {
        const res = await send(request(...turns.slice(0, n)))
        outs.push(JSON.parse(res.body) as { messages: unknown[] })
      }
      // Each request is a byte-identical prefix of the next, and all but the first carry earlier results.
      for (let n = 1; n < outs.length; n++) {
        const earlier = outs[n - 1]!.messages
        expect(JSON.stringify(outs[n]!.messages.slice(0, earlier.length)), `request ${n + 1}`).toBe(JSON.stringify(earlier))
      }
      expect(resultsOf(outs[9]).every(r => r.startsWith('[llm-fw: tool output condensed'))).toBe(true)
      // 10 results, 9 distinct originals.
      expect(worker.received).toHaveLength(9)
      expect(files('.txt')).toHaveLength(9)
      expect(files('.outcome')).toHaveLength(9)
    })

    it('makes one worker call for two requests carrying the same new result at once, and forwards the same bytes, as it does for a third later (FR-006)', async () => {
      reply = body => ({ delayMs: 300, json: chatAnswer(DEFAULT_FACTS, { prompt_tokens: promptTokensOf(body), completion_tokens: 8 }) })
      const body = request(turn([bash('toolu_1', 'npm test', output('shared'))]))
      const [a, b] = await Promise.all([send(body), send(body)])
      expect(worker.received).toHaveLength(1)
      expect(a.body).toBe(b.body)
      expect(a.body).not.toBe(a.input)

      const c = await send(body)
      expect(worker.received).toHaveLength(1)
      expect(c.body).toBe(a.body)
    })

    it('keeps the first outcome of more than 4,096 distinct results while they are carried, with no second worker call (D9)', async () => {
      // No worker set up: every result is decided whole. Dry run, so nothing is written to disk and only memory can remember them.
      m.shunt.workerUrl = ''
      m.shunt.minLines = 2
      const count = 4_100
      const calls = Array.from({ length: count }, (_, i) => bash(`toolu_${i}`, `step ${i}`, `first line ${i}\nsecond line ${i}`))
      const body = request(turn(calls))

      const first = await send(body, { dryRun: true })
      expect(first.body).toBe(first.input)

      // A worker appears. A result the module remembered stays as decided and costs no call; one it forgot would be asked about.
      // One new result rides along, which shows the module is asking the worker at all: it is the only call.
      m.shunt.workerUrl = worker.url
      const fresh = output('new after the 4,096th')
      const again = await send(request(turn([...calls, bash('toolu_new', 'step new', fresh)])), { dryRun: true })
      expect(again.results.slice(0, count).every((r, i) => r === first.results[i]), 'every one of the 4,100 earlier results kept its first outcome').toBe(true)
      expect(again.results[count]).toBe(renderCondensed(fresh, DEFAULT_FACTS, m.mod.store.pathFor(fresh)))
      expect(worker.received).toHaveLength(1)
    })

    it('keeps a result carried at least once per retention period over three periods, and decides one not carried for longer again (D9)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      reply = countingFacts()
      const kept = output('kept')
      const lapsed = output('lapsed')
      const first = await send(request(turn([bash('toolu_1', 'cargo build', kept), bash('toolu_2', 'cargo test', lapsed)])))
      const [keptText, lapsedText] = first.results
      expect(keptText!.startsWith('[llm-fw: tool output condensed')).toBe(true)
      expect(lapsedText!.startsWith('[llm-fw: tool output condensed')).toBe(true)
      expect(worker.received).toHaveLength(2)

      // Only memory is under test here, not the outcome files beside it: take both away, as a restart-free hour of sweeping would for results nobody carried.
      for (const text of [kept, lapsed]) {
        const outcome = join(folder(), `${keyOf('Bash', text)}.outcome`)
        expect(fs.existsSync(outcome)).toBe(true)
        fs.rmSync(outcome)
      }

      // Four steps of 0.9 retention periods: 3.6 periods, the first result carried at each step, the second never again.
      const step = 0.9 * m.shunt.retentionHours * HOUR
      for (let i = 0; i < 4; i++) {
        vi.setSystemTime(Date.now() + step)
        const res = await send(request(turn([bash('toolu_1', 'cargo build', kept)])))
        expect(res.results, `after ${i + 1} steps`).toEqual([keptText])
      }
      expect(worker.received).toHaveLength(2)

      const last = await send(request(turn([bash('toolu_1', 'cargo build', kept), bash('toolu_2', 'cargo test', lapsed)])))
      expect(last.results[0]).toBe(keptText)
      expect(last.results[1]!.startsWith('[llm-fw: tool output condensed')).toBe(true)
      expect(last.results[1]).not.toBe(lapsedText)
      expect(worker.received).toHaveLength(3)
    })
  })

  describe('remembered outcomes on disk (D9 C, FR-006)', () => {
    it('writes every decided outcome as <key>.outcome, the condensed text or the reason it stays whole (D9)', async () => {
      const condensed = output('condensed')
      const failing = output('worker-fails')
      const rejected = output('too-long')
      reply = body => {
        const text = JSON.stringify(body)
        if (text.includes('worker-fails')) return { status: 500 }
        // Longer than half the original: refused by the FR-005 cap.
        if (text.includes('too-long')) return { json: chatAnswer('failure '.repeat(1500), { prompt_tokens: promptTokensOf(body), completion_tokens: 1500 }) }
        return undefined
      }
      const small = rows(10)
      const res = await send(request(turn([bash('toolu_1', 'a', condensed), bash('toolu_2', 'b', failing), bash('toolu_3', 'c', rejected), bash('toolu_4', 'd', small)])))

      expect(await m.mod.store.readOutcome(keyOf('Bash', condensed))).toEqual({ condensed: res.results[0] })
      expect(await m.mod.store.readOutcome(keyOf('Bash', failing))).toEqual({ whole: 'worker-failed' })
      expect(await m.mod.store.readOutcome(keyOf('Bash', rejected))).toEqual({ whole: 'rejected' })
      // Steps 1 to 6 are recomputed on every request and kept nowhere.
      expect(await m.mod.store.readOutcome(keyOf('Bash', small))).toBeNull()
      expect(files('.outcome')).toHaveLength(3)
    })

    it('writes no outcome file and no folder in dry run, though it asks the worker (FR-015, US4-3)', async () => {
      const text = output('dry')
      const res = await send(request(turn([bash('toolu_1', 'npm test', text)])), { dryRun: true })
      expect(worker.received).toHaveLength(1)
      expect(fs.existsSync(folder())).toBe(false)
      expect(await m.mod.store.readOutcome(keyOf('Bash', text))).toBeNull()
      // What would have been forwarded is still computed, and reported as not applied.
      expect(res.results[0]).toBe(renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text)))
      expect(res.events.length).toBeGreaterThan(0)
      expect(res.events.every(e => e.applied === false)).toBe(true)
    })

    it('forwards a condensed result byte-identical and a whole one whole after a restart, with no worker call (D9 C)', async () => {
      reply = body => (JSON.stringify(body).includes('worker-fails') ? { status: 500 } : countingFacts()(body))
      const condensed = output('condensed')
      const failing = output('worker-fails')
      const body = request(turn([bash('toolu_1', 'a', condensed), bash('toolu_2', 'b', failing)]))
      const before = await send(body)
      expect(before.results[0]).not.toBe(condensed)
      expect(before.results[1]).toBe(failing)
      const callsBefore = worker.received.length

      const restarted = boot()
      reply = () => undefined
      const after = await send(body, {}, restarted.mgr)
      expect(after.body).toBe(before.body)
      expect(worker.received).toHaveLength(callsBefore)
      expect(files('.txt')).toEqual([`${sha256(condensed)}.txt`])
    })

    it('reads the outcome file once for two first requests that arrive together after a restart (D9 C)', async () => {
      const text = output('restart')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const before = await send(body)

      const restarted = boot()
      const read = vi.spyOn(restarted.mod.store, 'readOutcome')
      const [a, b] = await Promise.all([send(body, {}, restarted.mgr), send(body, {}, restarted.mgr)])
      expect(a.body).toBe(before.body)
      expect(b.body).toBe(before.body)
      expect(read.mock.calls.filter(([key]) => key === keyOf('Bash', text))).toHaveLength(1)
      expect(worker.received).toHaveLength(1)
    })

    it('decides a result again after a restart when its outcome file is gone, and writes the new outcome (D9 C)', async () => {
      reply = countingFacts()
      const text = output('swept')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const before = await send(body)
      const outcome = join(folder(), `${keyOf('Bash', text)}.outcome`)
      expect(fs.existsSync(outcome)).toBe(true)
      fs.rmSync(outcome)

      const restarted = boot()
      const after = await send(body, {}, restarted.mgr)
      expect(worker.received).toHaveLength(2)
      expect(after.results[0]!.startsWith('[llm-fw: tool output condensed')).toBe(true)
      expect(after.results[0]).not.toBe(before.results[0])
      expect(await restarted.mod.store.readOutcome(keyOf('Bash', text))).toEqual({ condensed: after.results[0] })
    })

    it('decides a result again after a restart when its outcome file was swept as expired (D9 C, FR-025)', async () => {
      reply = countingFacts()
      const text = output('expired')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const before = await send(body)
      const outcome = join(folder(), `${keyOf('Bash', text)}.outcome`)
      expect(fs.existsSync(outcome)).toBe(true)
      const old = new Date(Date.now() - 25 * HOUR)
      fs.utimesSync(outcome, old, old)
      expect(await m.mod.store.sweep(24 * HOUR)).toBeGreaterThanOrEqual(1)
      expect(fs.existsSync(outcome)).toBe(false)

      const restarted = boot()
      const after = await send(body, {}, restarted.mgr)
      expect(worker.received).toHaveLength(2)
      expect(after.results[0]!.startsWith('[llm-fw: tool output condensed')).toBe(true)
      expect(after.results[0]).not.toBe(before.results[0])
    })

    it.each([
      ['a condensed text without this result\'s stored path', (_text: string) => ({ condensed: '[llm-fw: tool output condensed]\nsome facts' })],
      ['a reason that is not a WholeReason', (_text: string) => ({ whole: 'bogus-reason' })],
    ])('decides a result again and replaces an outcome file holding %s (D9 C)', async (_label, bad) => {
      reply = countingFacts()
      const text = output('invalid')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      await m.mod.store.writeOutcome(keyOf('Bash', text), bad(text))

      const restarted = boot()
      const res = await send(body, {}, restarted.mgr)
      expect(worker.received).toHaveLength(1)
      expect(res.results[0]).toBe(renderCondensed(text, 'facts of call 1: 3 tests failed', restarted.mod.store.pathFor(text)))
      expect(await restarted.mod.store.readOutcome(keyOf('Bash', text))).toEqual({ condensed: res.results[0] })
    })
  })

  describe('a worker that cannot help (US3, FR-007, FR-008, FR-011)', () => {
    it('forwards a result whole and warns once, with both counts and no text, when the worker read less than it was sent (D12, FR-007, US3-8)', async () => {
      reply = () => ({ json: chatAnswer(DEFAULT_FACTS, { prompt_tokens: 137, completion_tokens: 9 }) })
      const text = `${output('partial')}\nPRIVATE-MARKER-9f2c`
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const res = await send(body)
      expect(res.body).toBe(res.input)
      expect(files('.txt')).toEqual([])

      const sent = estimateTokens(WORKER_INSTRUCTIONS) + estimateTokens(numberLines(text))
      const warnings = shuntWarnings()
      expect(warnings).toHaveLength(1)
      const line = JSON.stringify(warnings[0])
      expect(line.includes('137'), 'the tokens the worker reports reading').toBe(true)
      expect(line.includes(String(sent)), 'the tokens it was sent').toBe(true)
      expect(JSON.stringify(warn.mock.calls).includes('PRIVATE-MARKER-9f2c')).toBe(false)

      // The result stays whole on later requests, with no further call and no further warning.
      expect((await send(body)).body).toBe(res.input)
      expect(worker.received).toHaveLength(1)
      expect(shuntWarnings()).toHaveLength(1)

      // A worker that read all of what it was sent: a new result is condensed as in US1.
      reply = () => undefined
      const other = output('read-in-full')
      const ok = await send(request(turn([bash('toolu_2', 'npm test', other)])))
      expect(ok.results).toEqual([renderCondensed(other, DEFAULT_FACTS, m.mod.store.pathFor(other))])
    })

    it('adds at most one wait limit to a request carrying five eligible results (US3-4, FR-008)', async () => {
      m.shunt.waitMs = 400
      reply = () => ({ delayMs: 5_000 })
      const calls = [1, 2, 3, 4, 5].map(i => bash(`toolu_${i}`, `step ${i}`, output(`slow ${i}`)))
      const started = Date.now()
      const res = await send(request(turn(calls)))
      const elapsed = Date.now() - started
      // Five waits of the limit would take 2 s.
      expect(elapsed).toBeLessThan(1_200)
      expect(res.body).toBe(res.input)
      expect(worker.received.length).toBeGreaterThan(0)
    })

    it.each([
      ['not set up', () => { m.shunt.workerUrl = '' }],
      ['answering with an error', () => { reply = () => ({ status: 500 }) }],
      ['too slow', () => { m.shunt.waitMs = 300; reply = () => ({ delayMs: 5_000 }) }],
    ] as const)('forwards a result whole when the worker is %s, and whole again once it works (US3-1, US3-3)', async (_label, break_) => {
      break_()
      const text = output('broken')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const first = await send(body)
      expect(first.body).toBe(first.input)
      expect(first.modified).toBe(false)
      expect(files('.txt')).toEqual([])
      const calls = worker.received.length

      // The history must not change shape between turns: a result left whole stays whole.
      m.shunt.workerUrl = worker.url
      m.shunt.waitMs = 15_000
      reply = () => undefined
      const later = await send(body)
      expect(later.body).toBe(first.input)
      expect(worker.received).toHaveLength(calls)

      // Another result is condensed by the same, working worker: it was the decision that held the first one back.
      const fresh = output('fresh')
      const next = await send(request(turn([bash('toolu_2', 'npm test', fresh)])))
      expect(next.results).toEqual([renderCondensed(fresh, DEFAULT_FACTS, m.mod.store.pathFor(fresh))])
    })

    it.each([
      ['not set up', () => { m.shunt.workerUrl = '' }],
      ['answering with an error', () => { reply = () => ({ status: 500 }) }],
    ] as const)('says so once, without tool output, however many results find the worker %s (FR-007, FR-011)', async (_label, break_) => {
      break_()
      for (const tag of ['one', 'two', 'three']) await send(request(turn([bash(`toolu_${tag}`, 'npm test', output(tag))])))
      expect(shuntWarnings()).toHaveLength(1)
      expect(JSON.stringify(warn.mock.calls).includes('step 1 finished')).toBe(false)
    })

    it('treats a worker address that is not on this machine as no worker: nothing is sent, and it says so once (US3-7, FR-011)', async () => {
      m.shunt.workerUrl = 'http://10.0.0.5:11434'
      const fetched = vi.spyOn(globalThis, 'fetch')
      for (const tag of ['one', 'two', 'three']) {
        const res = await send(request(turn([bash(`toolu_${tag}`, 'npm test', output(tag))])))
        expect(res.body).toBe(res.input)
      }
      expect(fetched).not.toHaveBeenCalled()
      expect(worker.received).toHaveLength(0)
      expect(shuntWarnings()).toHaveLength(1)
    })

    it('does not ask the worker, and adds under 5 ms at the median, for a request with no eligible result (US3-5, SC-005)', async () => {
      await expectLive()
      const asked = worker.received.length
      // Thirty turns of 40-line outputs: all below the threshold.
      const turns = Array.from({ length: 30 }, (_, k) => turn([bash(`toolu_${k}`, `step ${k}`, output(`small ${k}`, 40))]))
      const input = JSON.stringify(request(...turns))
      const ctx = { ...BASE_CTX, screening: scannedScreening(input), remoteAddress: '127.0.0.1' }
      const times: number[] = []
      for (let i = 0; i < 41; i++) {
        const started = performance.now()
        const res = await m.mgr.transformScreened(input, ctx)
        times.push(performance.now() - started)
        expect(res.body).toBe(input)
      }
      expect(worker.received).toHaveLength(asked)
      expect(median(times)).toBeLessThan(5)
    })
  })

  describe('switches and settings (US4-1, US4-2, US4-5, US2-7, SC-008)', () => {
    it('applies a changed minLines to the next request (US4-5)', async () => {
      const text = output('live', 300)
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      expect((await send(body)).results).toEqual([text])
      expect(worker.received).toHaveLength(0)

      m.shunt.minLines = 250
      expect((await send(body)).results).toEqual([renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text))])
    })

    it('leaves the body identical, asks no worker and makes no folder while the module is off, and condenses once it is switched on (US4-1, US4-2, SC-008)', async () => {
      await expectLive()
      const asked = worker.received.length
      const text = output('off')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))

      m.shunt.enabled = false
      const off = await send(body)
      expect(off.body).toBe(off.input)
      expect(off.modified).toBe(false)
      expect(worker.received).toHaveLength(asked)
      expect(fs.existsSync(folder())).toBe(false)

      expect(m.mgr.setModuleEnabled('tool-result-shunt', true)).toBe(true)
      expect((await send(body)).results).toEqual([renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text))])
    })

    it('forwards a result whole, asks no worker and stores nothing for a caller not on this machine, and does not remember that (US2-7)', async () => {
      await expectLive()
      const asked = worker.received.length
      const text = output('remote')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))

      const remote = await send(body, { remoteAddress: '10.0.0.5' })
      expect(remote.body).toBe(remote.input)
      expect(worker.received).toHaveLength(asked)
      expect(fs.existsSync(folder())).toBe(false)

      // Where the caller is comes from the connection, not the result: the next local request condenses it.
      expect((await send(body)).results).toEqual([renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text))])
    })

    it('forwards a result whole for a request with no remote address at all (US2-7)', async () => {
      const text = output('unknown-address')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const res = await send(body, { remoteAddress: undefined })
      expect(res.body).toBe(res.input)
      expect(worker.received).toHaveLength(0)
      // With an address on this machine the same result is condensed.
      expect((await send(body)).results).toEqual([renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text))])
    })
  })

  describe('a store that cannot keep the original (US2-5, US7-3, US7-7)', () => {
    it.each(['failed', 'unrestricted', 'full'] as const)('forwards the original whole when the store answers %s, warns once, and keeps the decision (US2-5, US7-3, US7-7)', async result => {
      const write = vi.spyOn(m.mod.store, 'write').mockResolvedValue(result)
      const a = output('store-a')
      const b = output('store-b')
      const first = await send(request(turn([bash('toolu_1', 'npm test', a)])))
      expect(first.body).toBe(first.input)
      const second = await send(request(turn([bash('toolu_2', 'npm run lint', b)])))
      expect(second.body).toBe(second.input)
      expect(shuntWarnings()).toHaveLength(1)

      // The store works again: the result is still forwarded whole, so the history does not change shape.
      write.mockRestore()
      const again = await send(request(turn([bash('toolu_1', 'npm test', a)])))
      expect(again.body).toBe(first.input)
      expect(files('.txt')).toEqual([])
    })

    it('forwards a result whole when storing it would pass maxStoreMB, and deletes nothing to make room (FR-025, US7-7)', async () => {
      m.shunt.maxStoreMB = 0.001
      const text = output('over-cap')
      const res = await send(request(turn([bash('toolu_1', 'npm test', text)])))
      expect(res.body).toBe(res.input)
      expect(files('.txt')).toEqual([])
      expect(files('.tmp')).toEqual([])

      // With room for it, another result is condensed.
      m.shunt.maxStoreMB = 200
      const fits = output('under-cap')
      expect((await send(request(turn([bash('toolu_2', 'npm test', fits)])))).results).toEqual([renderCondensed(fits, DEFAULT_FACTS, m.mod.store.pathFor(fits))])
    })

    it('forwards a result whole, leaving no partial file, when the folder cannot be made (US2-5)', async () => {
      // A file where the folder belongs.
      fs.writeFileSync(folder(), 'not a folder')
      const text = output('no-folder')
      const res = await send(request(turn([bash('toolu_1', 'npm test', text)])))
      expect(res.body).toBe(res.input)
      expect(fs.statSync(folder()).isFile()).toBe(true)
      // The original and its outcome file both fail to be written: each problem is said once, not once per result.
      const said = shuntWarnings().length
      expect(said).toBeGreaterThanOrEqual(1)
      expect(said).toBeLessThanOrEqual(2)
      const other = await send(request(turn([bash('toolu_3', 'npm run lint', output('no-folder-either'))])))
      expect(other.body).toBe(other.input)
      expect(shuntWarnings()).toHaveLength(said)

      // Once the folder can be made, another result is condensed.
      fs.rmSync(folder())
      const fits = output('folder-made')
      expect((await send(request(turn([bash('toolu_2', 'npm test', fits)])))).results).toEqual([renderCondensed(fits, DEFAULT_FACTS, m.mod.store.pathFor(fits))])
    })
  })
})
