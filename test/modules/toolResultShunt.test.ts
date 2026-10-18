import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import fs from 'node:fs'
import { join, isAbsolute, relative, sep } from 'node:path'
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
      // The limit is long against the machine's jitter, so one wait and five waits stay far apart however
      // loaded the run is. With a 400 ms limit the full parallel unit run once took 2,235 ms here, up to
      // 1,835 ms of it beyond the one wait, against a bound of 1,200 ms; alone the test takes the limit plus ~60 ms.
      const waitMs = 3_000
      m.shunt.waitMs = waitMs
      // The worker answers after more than five limits together, so every wait runs to the end of its limit.
      reply = () => ({ delayMs: 6 * waitMs })
      const calls = [1, 2, 3, 4, 5].map(i => bash(`toolu_${i}`, `step ${i}`, output(`slow ${i}`)))
      const started = Date.now()
      const res = await send(request(turn(calls)))
      const elapsed = Date.now() - started
      // The bound is 3 limits, 9,000 ms. One shared limit takes waitMs plus the work around it, so it passes
      // until that work reaches 6,000 ms, 3.3 times the 1,835 ms seen. A request that waits once per result takes
      // at least 5 limits, 15,000 ms, whatever the load: a timer never fires early and the worker never answers
      // inside a limit. That is 6,000 ms over the bound before any contention adds to it, and contention only adds.
      expect(elapsed, `took ${elapsed} ms, one limit is ${waitMs} ms`).toBeLessThan(3 * waitMs)
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

  // -------------------------------------------------------------------------
  // T017 (slice S6): the module never condenses what the detection flagged or
  // did not scan (FR-012, US6). `ctx.screening` is the record the proxy and the
  // gateway fill while they screen; each case below fills one the way the
  // listener would, and the module has to read it. data-model.md "Screening
  // record" says what each note means, "Remembered outcome" what a flag does to
  // a decision already made.
  // -------------------------------------------------------------------------
  describe('results the detection flagged or did not scan (FR-012, US6)', () => {
    /** In every flagged text and nowhere else: if it turns up at the worker or in a file, a flagged result leaked. */
    const MARK = 'FLAGGED-MARK-3b7e'
    const marked = (tag: string): string => `${output(tag)}\n${MARK}-${tag}`
    const SECRET = `ghp_${'a'.repeat(36)}`

    /** Names of the files in the folder whose content holds `marker`. */
    const folderHolds = (marker: string): string[] => (fs.existsSync(folder())
      ? fs.readdirSync(folder()).filter(name => fs.readFileSync(join(folder(), name), 'utf8').includes(marker))
      : [])
    const workerSaw = (marker: string): boolean => JSON.stringify(worker.received).includes(marker)

    /** A record of a scan that reached every text of the body, then whatever else the case notes. */
    function scanned(payload: unknown, note: (screening: Screening) => void = () => {}): Screening {
      const screening = scannedScreening(JSON.stringify(payload))
      note(screening)
      return screening
    }

    describe('a result flagged on the request that first carries it (US6-2, US6-3, US6-6)', () => {
      interface Built { body: unknown; screening: Screening | undefined; flagged: string }
      // `flagged` is the text of the first result as the module receives it; the second result is `clean`.
      const cases: Array<{ label: string; siblingCondensed: boolean; build: (flagged: string, clean: string) => Built }> = [
        {
          label: 'the detection flagged it (noteItemFlag)',
          siblingCondensed: true,
          build: (flagged, clean) => {
            const body = request(turn([bash('toolu_flag', 'npm test', flagged), bash('toolu_ok', 'npm run lint', clean)]))
            return { body, screening: scanned(body, s => s.noteItemFlag(flagged)), flagged }
          },
        },
        {
          label: 'DLP found a secret in it and redacted it (noteDlp)',
          siblingCondensed: true,
          build: (flagged, clean) => {
            // The module is handed the body DLP has redacted; the record holds the one before.
            const redacted = `${flagged}\ntoken [REDACTED_GITHUB_TOKEN]`
            const before = request(turn([bash('toolu_flag', 'npm test', `${flagged}\ntoken ${SECRET}`), bash('toolu_ok', 'npm run lint', clean)]))
            const body = request(turn([bash('toolu_flag', 'npm test', redacted), bash('toolu_ok', 'npm run lint', clean)]))
            const screening = scanned(body, s => s.noteDlp(JSON.stringify(before), [{ type: 'github_token', label: 'GitHub token', match: SECRET, index: 0 }]))
            return { body, screening, flagged: redacted }
          },
        },
        {
          label: 'the MCP audit flagged its call (noteMcpAudit)',
          siblingCondensed: true,
          build: (flagged, clean) => {
            const body = request(turn([bash('toolu_flag', 'npm test', flagged), bash('toolu_ok', 'npm run lint', clean)]))
            return { body, screening: scanned(body, s => s.noteMcpAudit('toolu_flag')), flagged }
          },
        },
        {
          label: 'the scan failed open (incomplete), so no new result can be trusted',
          siblingCondensed: false,
          build: (flagged, clean) => {
            const body = request(turn([bash('toolu_flag', 'npm test', flagged), bash('toolu_ok', 'npm run lint', clean)]))
            return { body, screening: scanned(body, s => s.incomplete()), flagged }
          },
        },
        {
          label: 'the request has no record of what the detection judged',
          siblingCondensed: false,
          build: (flagged, clean) => {
            const body = request(turn([bash('toolu_flag', 'npm test', flagged), bash('toolu_ok', 'npm run lint', clean)]))
            return { body, screening: undefined, flagged }
          },
        },
      ]

      it.each(cases)('forwards it whole, never asks the worker, stores nothing of it, and keeps it whole once it is no longer flagged: $label (US6-2, US6-3, US6-6)', async ({ label, siblingCondensed, build }) => {
        const clean = output(`sibling ${label}`)
        const { body, screening, flagged } = build(marked(`flag ${label}`), clean)
        const first = await send(body, { screening })

        expect(first.results[0]).toBe(flagged)
        const condensedClean = renderCondensed(clean, DEFAULT_FACTS, m.mod.store.pathFor(clean))
        expect(first.results[1]).toBe(siblingCondensed ? condensedClean : clean)
        expect(worker.received).toHaveLength(siblingCondensed ? 1 : 0)
        expect(workerSaw(MARK)).toBe(false)
        expect(files('.txt')).toEqual(siblingCondensed ? [`${sha256(clean)}.txt`] : [])
        // What is kept of a flagged result is the decision, never its text.
        expect(await m.mod.store.readOutcome(keyOf('Bash', flagged))).toEqual({ whole: 'flagged' })
        expect(folderHolds(MARK)).toEqual([])

        // The next request is fully scanned and flags nothing: the history must not change shape.
        const later = await send(body)
        expect(later.body).toBe(first.body)
        expect(worker.received).toHaveLength(siblingCondensed ? 1 : 0)
        expect(folderHolds(MARK)).toEqual([])

        // Not a module that was off or broken: another result is condensed by the same worker.
        const fresh = output(`fresh ${label}`)
        const control = await send(request(turn([bash('toolu_fresh', 'npm run build', fresh)])))
        expect(control.results).toEqual([renderCondensed(fresh, DEFAULT_FACTS, m.mod.store.pathFor(fresh))])
      })
    })

    it('condenses the result a cut-short scan finished, and forwards the one it stopped on and the one it never reached whole, then and later (US6-3, US6-6, FR-006, audit 4 M1)', async () => {
      // Observe mode: the scan noted the first two items, the second would have blocked, and it went no further.
      const a = output('before the block')
      const b = marked('blocked')
      const c = marked('never reached')
      const body = request(turn([bash('toolu_1', 'npm test', a), bash('toolu_2', 'npm run lint', b), bash('toolu_3', 'npm run build', c)]))
      const screening = new Screening()
      screening.noteItemScanned(a)
      screening.noteItemScanned(b)
      screening.cutShort()

      const first = await send(body, { screening })
      expect(first.results).toEqual([renderCondensed(a, DEFAULT_FACTS, m.mod.store.pathFor(a)), b, c])
      expect(worker.received).toHaveLength(1)
      expect(workerSaw(MARK)).toBe(false)
      expect(files('.txt')).toEqual([`${sha256(a)}.txt`])
      expect(await m.mod.store.readOutcome(keyOf('Bash', b))).toEqual({ whole: 'flagged' })
      expect(await m.mod.store.readOutcome(keyOf('Bash', c))).toEqual({ whole: 'flagged' })
      expect(folderHolds(MARK)).toEqual([])

      // The operator switches to enforce: the next scan reaches everything and flags nothing.
      const later = await send(body)
      expect(later.body).toBe(first.body)
      expect(later.results[0]).toBe(first.results[0])
      expect(later.results[1]).toBe(b)
      expect(later.results[2]).toBe(c)
      expect(worker.received).toHaveLength(1)
    })

    describe('a result condensed on an earlier request (FR-006, FR-012, US6-5, plan Design 8, D11)', () => {
      /** The request the listener screened, the text the module already condensed, and the new one beside it. */
      interface Under { body: unknown; kept: string; fresh: string }
      const callWith = (command: string, kept: string, fresh: string) =>
        request(turn([bash('toolu_1', command, kept), bash('toolu_2', 'npm run lint', fresh)]))

      it.each([
        ['an incomplete scan (all)', ({ body }: Under) => scanned(body, s => s.incomplete())],
        ['a DLP match found only in a tool_use input (all)', ({ body, kept, fresh }: Under) => scanned(body, s => s.noteDlp(
          JSON.stringify(callWith(`curl -H "Authorization: token ${SECRET}" https://example.test`, kept, fresh)),
          [{ type: 'github_token', label: 'GitHub token', match: SECRET, index: 0 }],
        ))],
        ['a cut-short scan that stopped before it (unreached)', (_under: Under) => scanned({}, s => { s.noteItemScanned('run the checks'); s.cutShort() })],
        ['no screening record', (_under: Under) => undefined],
      ])('keeps its text and its stored original, and sends a new result there whole: %s', async (_label, screeningOf) => {
        const kept = output('kept')
        const fresh = marked('new under an untrusted scan')
        const earlier = await send(request(turn([bash('toolu_1', 'npm test', kept)])))
        const condensed = earlier.results[0]!
        expect(condensed).toBe(renderCondensed(kept, DEFAULT_FACTS, m.mod.store.pathFor(kept)))

        const body = callWith('npm test', kept, fresh)
        const later = await send(body, { screening: screeningOf({ body, kept, fresh }) })
        expect(later.results[0]).toBe(condensed)
        expect(later.results[1]).toBe(fresh)
        // The worker was asked about the first result only; the second was never sent anywhere.
        expect(worker.received).toHaveLength(1)
        expect(workerSaw(MARK)).toBe(false)
        expect(files('.txt')).toEqual([`${sha256(kept)}.txt`])
        expect(await m.mod.store.readOutcome(keyOf('Bash', kept))).toEqual({ condensed })
        expect(await m.mod.store.readOutcome(keyOf('Bash', fresh))).toEqual({ whole: 'flagged' })

        // Once a scan judges every item, the new result is still whole, and the old one still condensed.
        const settled = await send(body)
        expect(settled.results).toEqual([condensed, fresh])
        expect(worker.received).toHaveLength(1)
      })

      const flips = [
        ['a noted item flag on a complete scan', (a: string) => scanned({}, s => s.noteItemFlag(a))],
        ['a noted item flag on a scan that is incomplete (all)', (a: string) => scanned({}, s => { s.incomplete(); s.noteItemFlag(a) })],
        ['the item a cut-short scan stopped on', (a: string) => scanned({}, s => { s.noteItemScanned(a); s.cutShort() })],
        ['the MCP audit of its call', (_a: string) => scanned({}, s => s.noteMcpAudit('toolu_1'))],
      ] as const

      it.each(flips)('forwards it whole from the first request on which its own slot is flagged, and deletes its stored original: %s (US6-5, D11)', async (_label, screeningOf) => {
        const a = output('to be flagged')
        const body = request(turn([bash('toolu_1', 'npm test', a)]))
        const earlier = await send(body)
        expect(earlier.results[0]).toBe(renderCondensed(a, DEFAULT_FACTS, m.mod.store.pathFor(a)))
        expect(files('.txt')).toEqual([`${sha256(a)}.txt`])

        const flagged = await send(body, { screening: screeningOf(a) })
        expect(flagged.results).toEqual([a])
        expect(files('.txt')).toEqual([])
        expect(await m.mod.store.readOutcome(keyOf('Bash', a))).toEqual({ whole: 'flagged' })

        // Flagged once, whole for good: a later scan that flags nothing does not bring the condensation back.
        const later = await send(body)
        expect(later.results).toEqual([a])
        expect(worker.received).toHaveLength(1)
        expect(files('.txt')).toEqual([])
      })

      it('changes neither the stored original nor the outcome file of a result flagged in dry run, where a real request deletes the one and rewrites the other (US6-5, FR-015)', async () => {
        const dry = output('flagged in dry run')
        const real = output('flagged for real')
        const body = request(turn([bash('toolu_1', 'npm test', dry), bash('toolu_2', 'npm run lint', real)]))
        const earlier = await send(body)
        const [condensedDry, condensedReal] = earlier.results
        expect(condensedDry).toBe(renderCondensed(dry, DEFAULT_FACTS, m.mod.store.pathFor(dry)))
        const original = fs.readFileSync(m.mod.store.pathFor(dry))

        await send(body, { dryRun: true, screening: scanned(body, s => s.noteItemFlag(dry)) })
        expect(files('.txt').sort()).toEqual([`${sha256(dry)}.txt`, `${sha256(real)}.txt`].sort())
        expect(fs.readFileSync(m.mod.store.pathFor(dry)).equals(original)).toBe(true)
        expect(await m.mod.store.readOutcome(keyOf('Bash', dry))).toEqual({ condensed: condensedDry })
        expect(await m.mod.store.readOutcome(keyOf('Bash', real))).toEqual({ condensed: condensedReal })

        // Not a flag the module ignores: outside dry run the same kind of flag deletes the original and rewrites the outcome.
        const alone = request(turn([bash('toolu_2', 'npm run lint', real)]))
        await send(alone, { screening: scanned(alone, s => s.noteItemFlag(real)) })
        expect(files('.txt')).toEqual([`${sha256(dry)}.txt`])
        expect(await m.mod.store.readOutcome(keyOf('Bash', real))).toEqual({ whole: 'flagged' })
        expect(await m.mod.store.readOutcome(keyOf('Bash', dry))).toEqual({ condensed: condensedDry })
      })
    })

    it('keeps a flagged result whole after a restart from its outcome file, though nothing flags it any more (D9 C)', async () => {
      const flagged = marked('restart')
      const body = request(turn([bash('toolu_1', 'npm test', flagged)]))
      const before = await send(body, { screening: scanned(body, s => s.noteItemFlag(flagged)) })
      expect(before.results).toEqual([flagged])
      expect(await m.mod.store.readOutcome(keyOf('Bash', flagged))).toEqual({ whole: 'flagged' })

      const restarted = boot()
      const after = await send(body, {}, restarted.mgr)
      expect(after.results).toEqual([flagged])
      expect(after.body).toBe(before.body)
      expect(worker.received).toHaveLength(0)
      expect(folderHolds(MARK)).toEqual([])

      // The restarted module works: a new result is condensed.
      const fresh = output('after the restart')
      const control = await send(request(turn([bash('toolu_2', 'npm run build', fresh)])), {}, restarted.mgr)
      expect(control.results).toEqual([renderCondensed(fresh, DEFAULT_FACTS, restarted.mod.store.pathFor(fresh))])
    })

    it('keeps a flagged outcome whole after more than retentionHours uncarried, where a condensed one is decided again (D9)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      reply = countingFacts()
      const flagged = marked('lapsed flag')
      const plain = output('lapsed plain')
      const body = request(turn([bash('toolu_1', 'cargo build', flagged), bash('toolu_2', 'cargo test', plain)]))
      const first = await send(body, { screening: scanned(body, s => s.noteItemFlag(flagged)) })
      expect(first.results[0]).toBe(flagged)
      expect(first.results[1]!.startsWith('[llm-fw: tool output condensed')).toBe(true)
      expect(worker.received).toHaveLength(1)

      // Only memory is under test here, not the outcome files beside it (as in the condensed case of D9 above).
      for (const text of [flagged, plain]) fs.rmSync(join(folder(), `${keyOf('Bash', text)}.outcome`), { force: true })

      // Two retention periods and more with nothing carrying either result. An unrelated large result rides each step, so the hourly prune runs.
      for (let i = 0; i < 2; i++) {
        vi.setSystemTime(Date.now() + 1.1 * m.shunt.retentionHours * HOUR)
        await send(request(turn([bash(`toolu_other${i}`, 'ls', output(`unrelated ${i}`))])))
      }

      const last = await send(body)
      expect(last.results[0]).toBe(flagged)
      expect(workerSaw(MARK)).toBe(false)
      // Not a vacuous pass: the prune ran, and the result it dropped was asked about again.
      expect(last.results[1]!.startsWith('[llm-fw: tool output condensed')).toBe(true)
      expect(last.results[1]).not.toBe(first.results[1])
    })

    describe('an OpenAI Responses function_call_output, which the detection does not read (FR-012, FR-016, US1-6)', () => {
      const RESPONSES: Partial<GatewayModuleContext> = { target: 'api.openai.com', path: '/v1/responses' }
      const fnCall = (id: string) => ({ type: 'function_call', call_id: id, name: 'shell', arguments: JSON.stringify({ command: ['npm', 'test'] }) })
      const responsesRequest = (id: string, out: string) => ({
        model: 'gpt-5',
        input: [{ role: 'user', content: 'run the checks' }, fnCall(id), { type: 'function_call_output', call_id: id, output: out }],
      })
      /** What the detection makes of a Responses request: it scans the prompt, and no parser extracts the tool output. */
      function detectionOf(payload: unknown): Screening {
        const screening = new Screening()
        for (const slot of collectTextSlots(payload)) if (slot.kind !== 'tool_result') screening.noteItemScanned(slot.text)
        return screening
      }
      const json = (value: unknown): CapturedResponse => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(value)) })

      it('forwards it whole, never asks the worker, stores nothing, and keeps it whole on later requests (FR-012, FR-016, US1-6)', async () => {
        const out = marked('responses')
        const body = responsesRequest('call_1', out)
        const first = await send(body, { ...RESPONSES, screening: detectionOf(body) })
        expect(first.body).toBe(first.input)
        expect(first.modified).toBe(false)
        expect(worker.received).toHaveLength(0)
        expect(files('.txt')).toEqual([])
        expect(folderHolds(MARK)).toEqual([])

        const again = await send(body, { ...RESPONSES, screening: detectionOf(body) })
        expect(again.body).toBe(again.input)
        // Even a scan that did read it, later, does not bring the condensation in: the outcome was decided.
        const read = await send(body, RESPONSES)
        expect(read.body).toBe(read.input)
        expect(worker.received).toHaveLength(0)
        expect(files('.txt')).toEqual([])
      })

      it('forwards a thread continuation\'s output whole although the module learned its tool from the response, and condenses one the detection scanned (FR-012, US1-5, US1-6)', async () => {
        const unread = marked('continued')
        const read = output('continued and scanned')
        m.mgr.observeResponse('{}', { ...BASE_CTX, ...RESPONSES }, json({
          id: 'resp_1', object: 'response', status: 'completed',
          output: [fnCall('call_thread'), fnCall('call_thread_scanned')],
        }))
        const continuation = (id: string, out: string) => ({
          model: 'gpt-5', previous_response_id: 'resp_1',
          input: [{ type: 'function_call_output', call_id: id, output: out }],
        })

        const body = continuation('call_thread', unread)
        const first = await send(body, { ...RESPONSES, screening: detectionOf(body) })
        expect(first.body).toBe(first.input)
        expect(worker.received).toHaveLength(0)
        expect(files('.txt')).toEqual([])

        // The same continuation form is condensed once the output was scanned: the tool was known, and the scan is what held the first back.
        const scannedBody = continuation('call_thread_scanned', read)
        const condensed = await send(scannedBody, { ...RESPONSES, screening: scanned(scannedBody) })
        expect(condensed.results).toEqual([renderCondensed(read, DEFAULT_FACTS, m.mod.store.pathFor(read))])
        expect(worker.received).toHaveLength(1)

        const later = await send(body, RESPONSES)
        expect(later.body).toBe(later.input)
        expect(workerSaw(MARK)).toBe(false)
        expect(folderHolds(MARK)).toEqual([])
      })
    })

    describe('a flag that reaches a result another request is deciding (SC-009, data-model.md "Disk order", audit 4 M2)', () => {
      /** Everything a settled race has to leave: no copy of the text, `flagged` on disk, and whole after a restart. */
      async function expectFlaggedEverywhere(text: string, body: unknown): Promise<void> {
        expect(folderHolds(MARK)).toEqual([])
        expect(files('.txt')).toEqual([])
        expect(await m.mod.store.readOutcome(keyOf('Bash', text))).toEqual({ whole: 'flagged' })
        const asked = worker.received.length
        const restarted = boot()
        const after = await send(body, {}, restarted.mgr)
        expect(after.results).toEqual([text])
        expect(worker.received).toHaveLength(asked)
        expect(folderHolds(MARK)).toEqual([])
      }

      it('ends flagged when the flag comes before the worker has answered the other request, whichever request settles last', async () => {
        reply = body => ({ delayMs: 400, json: chatAnswer(DEFAULT_FACTS, { prompt_tokens: promptTokensOf(body), completion_tokens: 8 }) })
        const text = marked('flag before the answer')
        const body = request(turn([bash('toolu_1', 'npm test', text)]))
        const deciding = send(body)
        await vi.waitFor(() => expect(worker.received).toHaveLength(1))

        const flagging = await Promise.all([deciding, send(body, { screening: scanned(body, s => s.noteItemFlag(text)) })])
        // The flagging request forwards the result whole, and the worker was asked once, by the request that got there first.
        expect(flagging[1].results).toEqual([text])
        expect(worker.received).toHaveLength(1)
        await expectFlaggedEverywhere(text, body)
      })

      it('ends flagged when the flag comes while the other request\'s write of the original is held, whichever request settles last', async () => {
        const text = marked('flag during the write')
        const body = request(turn([bash('toolu_1', 'npm test', text)]))
        const store = m.mod.store
        const realWrite = store.write.bind(store)
        let release: () => void = () => {}
        const gate = new Promise<void>(resolve => { release = resolve })
        const write = vi.spyOn(store, 'write').mockImplementation(async original => {
          await gate
          return realWrite(original)
        })

        const deciding = send(body)
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
        const flagging = send(body, { screening: scanned(body, s => s.noteItemFlag(text)) })
        // Let the flag land while the write is still held, then let the write go.
        await new Promise(resolve => setTimeout(resolve, 100))
        release()
        const [, flagged] = await Promise.all([deciding, flagging])

        expect(flagged.results).toEqual([text])
        write.mockRestore()
        await expectFlaggedEverywhere(text, body)
      })
    })
  })

  // -------------------------------------------------------------------------
  // T027 (slice S14): FR-024. A request that carries a remembered result keeps
  // its files alive (the mtime is the last carry, data-model.md "Stored
  // original") and puts back any that are gone, at the same path, before it is
  // forwarded; the condensed text a conversation already holds never changes.
  // A write-back that fails forwards the remembered text anyway. The outcome
  // files are kept the same way, and a missing one is not a missing original
  // (D9 C). `scannedScreening` is T015's: every text reached, none flagged.
  // -------------------------------------------------------------------------
  describe('carrying a remembered result keeps its files alive and writes back what is gone (FR-024, US7-4, US7-6, US7-8, US7-9, D9 C)', () => {
    const outcomeFile = (toolName: string, text: string): string => join(folder(), `${keyOf(toolName, text)}.outcome`)
    const mtime = (path: string): number => fs.statSync(path).mtimeMs
    /** A file's text; a file that is not there fails the assertion, instead of throwing from the read. */
    const contentOf = (path: string): string => {
      expect(fs.existsSync(path), `${relative(root, path)} should exist`).toBe(true)
      return fs.readFileSync(path, 'utf8')
    }
    /** Make the file look unused for `hours`, and return the time it was set to. */
    const age = (path: string, hours: number): number => {
      const then = new Date(Date.now() - hours * HOUR)
      fs.utimesSync(path, then, then)
      return then.getTime()
    }
    /** The card's count of stored originals that could not be written back. */
    const missing = (): number | string | undefined => m.mod.getStats().kpis?.find(k => k.key === 'missing')?.value
    /** A record in which the detection flagged `text`. */
    const flaggedScreening = (payload: unknown, text: string): Screening => {
      const screening = scannedScreening(JSON.stringify(payload))
      screening.noteItemFlag(text)
      return screening
    }
    const isCondensed = (text: string | undefined): boolean => text !== undefined && text.startsWith('[llm-fw: tool output condensed')

    it('sets the mtime of the stored original and of its outcome file to now on every carry, so a sweep spares a result still in use (US7-4, FR-024)', async () => {
      const text = output('carried')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const first = await send(body)
      expect(isCondensed(first.results[0])).toBe(true)
      const original = m.mod.store.pathFor(text)
      const outcome = outcomeFile('Bash', text)

      // Both look unused for 30 hours: past the retention period, and nothing has swept them yet.
      const old = age(original, 30)
      age(outcome, 30)
      expect(mtime(original)).toBeLessThan(Date.now() - 29 * HOUR)

      const before = Date.now()
      const again = await send(body)
      expect(again.body).toBe(first.body)
      expect(mtime(original), 'the stored original of a carried result').toBeGreaterThanOrEqual(before - 1_000)
      expect(mtime(outcome), 'its outcome file').toBeGreaterThanOrEqual(before - 1_000)
      expect(mtime(original)).toBeGreaterThan(old + 29 * HOUR)

      // What the touch is for: the sweep that would have deleted both finds them in use.
      expect(await m.mod.store.sweep(m.shunt.retentionHours * HOUR)).toBe(0)
      expect(files('.txt')).toEqual([`${sha256(text)}.txt`])
      expect(files('.outcome')).toEqual([`${keyOf('Bash', text)}.outcome`])
      expect(worker.received).toHaveLength(1)
    })

    it('sets both mtimes to now for a result an outcome file brought back after a restart, on the first request that carries it (US7-4, D9 C)', async () => {
      const text = output('carried after restart')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const first = await send(body)
      const original = m.mod.store.pathFor(text)
      const outcome = outcomeFile('Bash', text)
      age(original, 30)
      age(outcome, 30)

      const restarted = boot()
      const before = Date.now()
      const after = await send(body, {}, restarted.mgr)
      expect(after.body).toBe(first.body)
      expect(worker.received).toHaveLength(1)
      expect(mtime(original)).toBeGreaterThanOrEqual(before - 1_000)
      expect(mtime(outcome)).toBeGreaterThanOrEqual(before - 1_000)
    })

    it.each([['worker-failed', false], ['flagged', true]] as const)(
      'sets the mtime of the outcome file of a result forwarded whole (%s) to now on every carry, and writes it back, with the same content and not counted missing, when it is gone (D9 C)',
      async (reason, flag) => {
        if (!flag) reply = () => ({ status: 500 })
        const text = output(`whole ${reason}`)
        const body = request(turn([bash('toolu_1', 'npm test', text)]))
        const first = await send(body, flag ? { screening: flaggedScreening(body, text) } : {})
        expect(first.results).toEqual([text])
        const outcome = outcomeFile('Bash', text)
        expect(await m.mod.store.readOutcome(keyOf('Bash', text))).toEqual({ whole: reason })
        const content = contentOf(outcome)

        age(outcome, 30)
        const before = Date.now()
        const again = await send(body)
        expect(again.results).toEqual([text])
        expect(mtime(outcome)).toBeGreaterThanOrEqual(before - 1_000)

        fs.rmSync(outcome)
        const back = await send(body)
        expect(back.results).toEqual([text])
        expect(contentOf(outcome)).toBe(content)
        // Whole means no stored original, and an outcome file is not an original.
        expect(files('.txt')).toEqual([])
        expect(missing()).toBe(0)
        expect(worker.received).toHaveLength(flag ? 0 : 1)
      },
    )

    it('writes back the outcome file of a condensed result, holding the text as forwarded, and keeps it across a restart; it is not counted missing (D9 C)', async () => {
      const text = output('outcome gone')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const first = await send(body)
      const outcome = outcomeFile('Bash', text)
      const content = contentOf(outcome)
      fs.rmSync(outcome)

      const again = await send(body)
      expect(again.body).toBe(first.body)
      expect(contentOf(outcome)).toBe(content)
      expect(await m.mod.store.readOutcome(keyOf('Bash', text))).toEqual({ condensed: first.results[0] })
      expect(missing()).toBe(0)

      const restarted = boot()
      const after = await send(body, {}, restarted.mgr)
      expect(after.body).toBe(first.body)
      expect(worker.received).toHaveLength(1)
    })

    it('writes the stored original back at the same path, identical, before the request is forwarded, after the operator purged the store (US7-6, FR-024)', async () => {
      const a = output('purged a')
      const b = output('purged b')
      const body = request(turn([bash('toolu_a', 'npm test', a), bash('toolu_b', 'npm run lint', b)]))
      const first = await send(body)
      expect(files('.txt')).toHaveLength(2)

      expect(await m.mod.store.purge()).toBeGreaterThanOrEqual(4)
      expect(fs.readdirSync(folder())).toEqual([])

      const again = await send(body)
      // The files are there when the call returns, the text is what the conversation holds, and the worker was not asked again.
      expect(again.body).toBe(first.body)
      expect(again.results).toEqual([a, b].map(text => renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text))))
      for (const text of [a, b]) {
        expect(contentOf(m.mod.store.pathFor(text))).toBe(text)
        expect(await m.mod.store.readOutcome(keyOf('Bash', text))).toEqual({ condensed: renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text)) })
      }
      expect(worker.received).toHaveLength(2)
      expect(missing()).toBe(0)
      expect(shuntWarnings()).toEqual([])
    })

    it('writes the stored original back, identical and unchanged in the history, when it was deleted by hand while a conversation resends it (US7-8, FR-024)', async () => {
      const a = output('by hand a')
      const b = output('by hand b')
      const c = output('by hand c')
      const t1 = turn([bash('toolu_1', 'npm test', a)])
      const t2 = turn([bash('toolu_2', 'npm run lint', b)])
      await send(request(t1))
      const second = await send(request(t1, t2))

      fs.rmSync(m.mod.store.pathFor(a))
      const third = await send(request(t1, t2))
      expect(third.body).toBe(second.body)
      expect(contentOf(m.mod.store.pathFor(a))).toBe(a)
      expect(files('.txt').sort()).toEqual([`${sha256(a)}.txt`, `${sha256(b)}.txt`].sort())

      // The conversation goes on: the earlier turns keep the wording they had, and the new result is condensed after them.
      const fourth = await send(request(t1, t2, turn([bash('toolu_3', 'npm run build', c)])))
      expect(fourth.results.slice(0, 2)).toEqual(second.results)
      expect(isCondensed(fourth.results[2])).toBe(true)
      expect(worker.received).toHaveLength(3)
      expect(missing()).toBe(0)
    })

    describe('a write-back that fails (US7-9)', () => {
      it.each(['full', 'failed'] as const)('forwards the remembered condensed text, warns once however many requests follow, and counts each on the card when the store answers %s', async answer => {
        const text = output(`no write-back ${answer}`)
        const body = request(turn([bash('toolu_1', 'npm test', text)]))
        const first = await send(body)
        expect(isCondensed(first.results[0])).toBe(true)
        expect(shuntWarnings()).toEqual([])
        expect(missing()).toBe(0)

        fs.rmSync(m.mod.store.pathFor(text))
        const write = vi.spyOn(m.mod.store, 'write').mockResolvedValue(answer)
        for (const requests of [1, 2, 3]) {
          const res = await send(body)
          expect(res.body).toBe(first.body)
          expect(missing(), `after ${requests} requests`).toBe(requests)
          expect(shuntWarnings(), `after ${requests} requests`).toHaveLength(1)
        }
        expect(write).toHaveBeenCalled()
        expect(files('.txt')).toEqual([])
        expect(worker.received).toHaveLength(1)
        // A warning names the problem, never the output (FR-014).
        expect(JSON.stringify(shuntWarnings())).not.toContain('step 1 finished')

        // The store works again: the next carry puts the original back, the text is the one remembered, and nothing more is counted.
        write.mockRestore()
        const healed = await send(body)
        expect(healed.body).toBe(first.body)
        expect(contentOf(m.mod.store.pathFor(text))).toBe(text)
        expect(missing()).toBe(3)
        expect(shuntWarnings()).toHaveLength(1)
      })

      it('does the same when the folder itself cannot be written to, and puts both files back once it can (US7-9, FR-024)', async () => {
        const text = output('folder unwritable')
        const body = request(turn([bash('toolu_1', 'npm test', text)]))
        const first = await send(body)
        expect(isCondensed(first.results[0])).toBe(true)

        // A file where the folder belongs: nothing can be written, and nothing is there to touch.
        fs.rmSync(folder(), { recursive: true, force: true })
        fs.writeFileSync(folder(), 'not a folder')
        const res = await send(body)
        expect(res.body).toBe(first.body)
        expect(missing()).toBe(1)
        // The original and the outcome file both fail: the problem is said once or twice in all, not once per request.
        const said = shuntWarnings().length
        expect(said).toBeGreaterThanOrEqual(1)
        expect(said).toBeLessThanOrEqual(2)
        for (const requests of [2, 3]) {
          expect((await send(body)).body).toBe(first.body)
          expect(missing()).toBe(requests)
        }
        expect(shuntWarnings()).toHaveLength(said)
        expect(fs.statSync(folder()).isFile()).toBe(true)

        fs.rmSync(folder())
        const healed = await send(body)
        expect(healed.body).toBe(first.body)
        expect(contentOf(m.mod.store.pathFor(text))).toBe(text)
        expect(await m.mod.store.readOutcome(keyOf('Bash', text))).toEqual({ condensed: first.results[0] })
        expect(missing()).toBe(3)
        expect(worker.received).toHaveLength(1)
      })
    })

    it('touches nothing and writes nothing in a dry run, files gone or present, and does both on the next live request (FR-015, US4-3, FR-024)', async () => {
      const text = output('dry carry')
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const first = await send(body)
      const original = m.mod.store.pathFor(text)
      const outcome = outcomeFile('Bash', text)

      // Present and old: a dry run leaves their mtimes alone.
      const oldOriginal = age(original, 5)
      const oldOutcome = age(outcome, 5)
      await send(body, { dryRun: true })
      expect(Math.abs(mtime(original) - oldOriginal)).toBeLessThan(1_000)
      expect(Math.abs(mtime(outcome) - oldOutcome)).toBeLessThan(1_000)

      // Gone: a dry run writes neither back, warns of nothing and counts nothing missing.
      fs.rmSync(original)
      fs.rmSync(outcome)
      await send(body, { dryRun: true })
      expect(files('.txt')).toEqual([])
      expect(files('.outcome')).toEqual([])
      expect(missing()).toBe(0)
      expect(shuntWarnings()).toEqual([])

      // Not a module that did nothing: the next live request puts both back.
      const live = await send(body)
      expect(live.body).toBe(first.body)
      expect(files('.txt')).toEqual([`${sha256(text)}.txt`])
      expect(files('.outcome')).toEqual([`${keyOf('Bash', text)}.outcome`])
    })

    it('ends flagged, with no stored original and a flagged outcome file, when the write-back of the original is held while another request flags the result (data-model.md "Disk order", audit 4 M2)', async () => {
      const MARK = 'WRITEBACK-MARK-5d2a'
      const text = `${output('held write-back')}\n${MARK}`
      const body = request(turn([bash('toolu_1', 'npm test', text)]))
      const first = await send(body)
      expect(isCondensed(first.results[0])).toBe(true)

      // The original is gone, so the next carry has to write it back; hold that write.
      const store = m.mod.store
      fs.rmSync(store.pathFor(text))
      const realWrite = store.write.bind(store)
      let release: () => void = () => {}
      const gate = new Promise<void>(resolve => { release = resolve })
      const write = vi.spyOn(store, 'write').mockImplementation(async original => {
        await gate
        return realWrite(original)
      })

      const writingBack = send(body)
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
      const flagging = send(body, { screening: flaggedScreening(body, text) })
      // Let the flag land while the write-back is still held, then let it go.
      await new Promise(resolve => setTimeout(resolve, 100))
      release()
      const [, flagged] = await Promise.all([writingBack, flagging])
      write.mockRestore()

      expect(flagged.results).toEqual([text])
      expect(files('.txt')).toEqual([])
      expect(fs.readdirSync(folder()).filter(name => fs.readFileSync(join(folder(), name), 'utf8').includes(MARK))).toEqual([])
      expect(await store.readOutcome(keyOf('Bash', text))).toEqual({ whole: 'flagged' })

      // And a restart finds it whole, with no worker call and nothing written back.
      const asked = worker.received.length
      const restarted = boot()
      const after = await send(body, {}, restarted.mgr)
      expect(after.results).toEqual([text])
      expect(worker.received).toHaveLength(asked)
      expect(files('.txt')).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // T023 (slice S12): the module's card. `getStats().kpis` is what the
  // dashboard draws; data-model.md "Counters" fixes the keys, the labels (the
  // unit is part of the label) and what each value counts. Values are counted
  // per tool-result occurrence in a request, so a result carried by three
  // requests counts three times; worker tokens are counted per worker call.
  // -------------------------------------------------------------------------
  describe('the module card (US4-4, FR-017, FR-014, US4-6)', () => {
    type Kpi = { key: string; label: string; value: number | string }
    const kpis = (): Kpi[] => m.mod.getStats().kpis ?? []
    const kpi = (key: string): number | string | undefined => kpis().find(k => k.key === key)?.value

    // Keys and labels of data-model.md "Counters", in the order the spec lists
    // them (US4-4): condensed, whole by reason, tokens, worker tokens, wait,
    // the store, the missing originals.
    const CARD: Array<[string, string]> = [
      ['condensed', 'Results condensed'],
      ['whole', 'Forwarded whole'],
      ['originalTokens', 'Original tokens'],
      ['condensedTokens', 'Condensed tokens'],
      ['workerIn', 'Worker tokens read'],
      ['workerOut', 'Worker tokens written'],
      ['waitAvgMs', 'Average wait added (ms)'],
      ['waitMaxMs', 'Longest wait added (ms)'],
      ['storedFiles', 'Stored originals'],
      ['storedBytes', 'Stored size (bytes)'],
      ['missing', 'Stored originals missing'],
    ]
    const NUMERIC = CARD.map(([key]) => key).filter(key => key !== 'whole')

    // The worker answers every result with the default facts and 7 tokens
    // written, except one whose text carries `worker-fails` (an error) or
    // `too-long` (an answer over the FR-005 cap, 1,500 tokens written).
    beforeEach(() => {
      reply = body => {
        const text = JSON.stringify(body)
        if (text.includes('worker-fails')) return { status: 500 }
        if (text.includes('too-long')) return { json: chatAnswer('failure '.repeat(1500), { prompt_tokens: promptTokensOf(body), completion_tokens: 1500 }) }
        return { json: chatAnswer(DEFAULT_FACTS, { prompt_tokens: promptTokensOf(body), completion_tokens: 7 }) }
      }
    })

    /** The tokens the worker reported over every call it answered. */
    const workerTokens = (): { in: number; out: number } => worker.received.reduce((total, received) => {
      const text = JSON.stringify(received.body)
      if (text.includes('worker-fails')) return total
      return { in: total.in + promptTokensOf(received.body), out: total.out + (text.includes('too-long') ? 1500 : 7) }
    }, { in: 0, out: 0 })

    const folderBytes = (names: string[]): number => names.reduce((total, name) => total + fs.statSync(join(folder(), name)).size, 0)

    it('lists the keys and labels of data-model.md "Counters" in order, with every figure at zero on a module that has handled nothing (FR-017, US4-4)', () => {
      expect(kpis().map(k => [k.key, k.label])).toEqual(CARD)
      for (const key of NUMERIC) expect(kpi(key), key).toBe(0)
      expect(typeof kpi('whole')).toBe('string')
      expect(String(kpi('whole'))).not.toMatch(/\d/)
      // The base fields of a payload module stay.
      expect(m.mod.getStats()).toMatchObject({ id: 'tool-result-shunt', name: 'Tool Result Shunt', enabled: true })
    })

    it('counts condensed results, the tokens of their originals and of what replaced them, and the worker tokens; a result carried by three requests counts three times, its worker call once (US4-4)', async () => {
      const a = output('card-a')
      const b = output('card-b')
      const body = request(turn([bash('toolu_1', 'npm test', a), bash('toolu_2', 'npm run lint', b)]))

      const first = await send(body)
      expect(first.results).toEqual([renderCondensed(a, DEFAULT_FACTS, m.mod.store.pathFor(a)), renderCondensed(b, DEFAULT_FACTS, m.mod.store.pathFor(b))])
      expect(kpi('condensed')).toBe(2)
      const original = estimateTokens(a) + estimateTokens(b)
      const condensed = estimateTokens(first.results[0]!) + estimateTokens(first.results[1]!)
      expect(kpi('originalTokens')).toBe(original)
      expect(kpi('condensedTokens')).toBe(condensed)
      expect(kpi('workerIn')).toBe(promptTokensOf(worker.received[0]!.body) + promptTokensOf(worker.received[1]!.body))
      expect(kpi('workerOut')).toBe(14)
      expect(String(kpi('whole'))).not.toMatch(/\d/)

      await send(body)
      await send(body)
      expect(worker.received).toHaveLength(2)
      expect(kpi('condensed')).toBe(6)
      expect(kpi('originalTokens')).toBe(3 * original)
      expect(kpi('condensedTokens')).toBe(3 * condensed)
      expect(kpi('workerIn')).toBe(workerTokens().in)
      expect(kpi('workerOut')).toBe(14)
    })

    // Each case makes exactly one result be forwarded whole for its reason,
    // using a unique tag so no case shares a decision with another. The
    // `workerAsked` flag says whether the worker answered with usage, so its
    // tokens are counted: not for a rule decided before the worker, nor for an
    // error that carries no usage.
    const WHOLE: Array<{ reason: string; workerAsked: boolean; arrange: () => Promise<unknown> }> = [
      { reason: 'below-threshold', workerAsked: false, arrange: () => send(request(turn([bash('toolu_bt', 'ls', rows(10))]))) },
      { reason: 'excluded-tool', workerAsked: false, arrange: () => send(request(turn([call('toolu_ex', 'Read', { file_path: '/a/b.ts' }, output('card-read'))]))) },
      {
        reason: 'tool-unknown',
        workerAsked: false,
        // A thread continuation carries the result without its call, and nothing has taught the module that call.
        arrange: () => send({
          model: 'claude-sonnet-5-5', stream: true,
          thread: { type: 'continue', previous_message_id: 'msg_card' },
          messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_card_unknown', content: output('card-unknown') }] }],
        }),
      },
      {
        reason: 'too-large',
        workerAsked: false,
        arrange: async () => {
          m.shunt.maxInputChars = 1_000
          try { await send(request(turn([bash('toolu_tl', 'npm test', output('card-large'))]))) } finally { m.shunt.maxInputChars = DEFAULT_CONFIG.modules!.toolResultShunt!.maxInputChars }
        },
      },
      { reason: 'remote-client', workerAsked: false, arrange: () => send(request(turn([bash('toolu_rc', 'npm test', output('card-remote'))])), { remoteAddress: '10.0.0.5' }) },
      {
        reason: 'flagged',
        workerAsked: false,
        arrange: () => {
          const text = output('card-flagged')
          const body = request(turn([bash('toolu_fl', 'npm test', text)]))
          const screening = scannedScreening(JSON.stringify(body))
          screening.noteItemFlag(text)
          return send(body, { screening })
        },
      },
      { reason: 'worker-failed', workerAsked: false, arrange: () => send(request(turn([bash('toolu_wf', 'npm test', output('worker-fails'))]))) },
      { reason: 'rejected', workerAsked: true, arrange: () => send(request(turn([bash('toolu_rj', 'npm test', output('too-long'))]))) },
      {
        reason: 'store-failed',
        workerAsked: true,
        arrange: async () => {
          const write = vi.spyOn(m.mod.store, 'write').mockResolvedValue('failed')
          try { await send(request(turn([bash('toolu_sf', 'npm test', output('card-store-failed'))]))) } finally { write.mockRestore() }
        },
      },
      {
        reason: 'store-full',
        workerAsked: true,
        arrange: async () => {
          const write = vi.spyOn(m.mod.store, 'write').mockResolvedValue('full')
          try { await send(request(turn([bash('toolu_sl', 'npm test', output('card-store-full'))]))) } finally { write.mockRestore() }
        },
      },
    ]

    it.each(WHOLE)('counts a result forwarded whole as "$reason 1", and none as condensed (US4-4)', async ({ reason, workerAsked, arrange }) => {
      await arrange()
      expect(kpi('whole')).toBe(`${reason} 1`)
      expect(kpi('condensed')).toBe(0)
      expect(kpi('originalTokens')).toBe(0)
      expect(kpi('condensedTokens')).toBe(0)
      // Not a card that counts nothing: the worker tokens are the ones the worker reported, when it answered.
      expect(workerAsked ? (kpi('workerIn') as number) > 0 && (kpi('workerOut') as number) > 0 : kpi('workerIn') === 0 && kpi('workerOut') === 0).toBe(true)
      expect(kpi('workerIn')).toBe(workerTokens().in)
      expect(kpi('workerOut')).toBe(workerTokens().out)
    })

    it('counts a result forwarded whole once per request that carries it, as it counts a condensed one (US4-4)', async () => {
      const body = request(turn([bash('toolu_1', 'npm test', output('worker-fails'))]))
      for (let i = 0; i < 3; i++) await send(body)
      expect(worker.received).toHaveLength(1)
      expect(kpi('whole')).toBe('worker-failed 3')
    })

    it('after a mix of condensed, whole-for-every-reason and dry-run requests, lists only the non-zero reasons, in the order of data-model.md, joined by " · " (US4-4, FR-015)', async () => {
      const a = output('card-mix-a')
      const b = output('card-mix-b')
      await send(request(turn([bash('toolu_a', 'npm test', a), bash('toolu_b', 'npm run lint', b)])))
      // In the reverse of the order the card lists them, so the order cannot be that of arrival.
      for (const { arrange } of [...WHOLE].reverse()) await arrange()
      const dry = output('card-mix-dry')
      const dryRun = await send(request(turn([bash('toolu_d', 'npm run build', dry)])), { dryRun: true })

      expect(kpi('whole')).toBe('below-threshold 1 · excluded-tool 1 · tool-unknown 1 · too-large 1 · remote-client 1 · flagged 1 · worker-failed 1 · rejected 1 · store-failed 1 · store-full 1')
      // Two live condensations and the one a dry run would have made; no whole result adds a token.
      expect(kpi('condensed')).toBe(3)
      expect(kpi('originalTokens')).toBe(estimateTokens(a) + estimateTokens(b) + estimateTokens(dry))
      expect(kpi('condensedTokens')).toBe(estimateTokens(renderCondensed(a, DEFAULT_FACTS, m.mod.store.pathFor(a))) + estimateTokens(renderCondensed(b, DEFAULT_FACTS, m.mod.store.pathFor(b))) + estimateTokens(dryRun.results[0]!))
      expect(kpi('workerIn')).toBe(workerTokens().in)
      expect(kpi('workerOut')).toBe(workerTokens().out)
      // `missing` counts failed write-backs (T028); nothing was written back here.
      expect(kpi('missing')).toBe(0)
      // The dry-run result was condensed in the count only: nothing of it is stored.
      expect(files('.txt').sort()).toEqual([`${sha256(a)}.txt`, `${sha256(b)}.txt`].sort())
      expect(kpi('storedFiles')).toBe(2)
    })

    it('counts what a dry run would have saved, stores nothing for it, and reports its events as not applied (FR-015, US4-3, US4-4)', async () => {
      const text = output('card-dry-run')
      const res = await send(request(turn([bash('toolu_1', 'npm test', text)])), { dryRun: true })
      expect(res.results[0]).toBe(renderCondensed(text, DEFAULT_FACTS, m.mod.store.pathFor(text)))
      expect(kpi('condensed')).toBe(1)
      expect(kpi('originalTokens')).toBe(estimateTokens(text))
      expect(kpi('condensedTokens')).toBe(estimateTokens(res.results[0]!))
      expect(kpi('workerIn')).toBe(workerTokens().in)
      expect(kpi('workerIn') as number).toBeGreaterThan(0)
      expect(kpi('storedFiles')).toBe(0)
      expect(kpi('storedBytes')).toBe(0)
      expect(fs.existsSync(folder())).toBe(false)
      expect(res.events.length).toBeGreaterThan(0)
      expect(res.events.every(e => e.applied === false)).toBe(true)
    })

    it('counts the stored originals only as storedFiles, and every file of the folder, outcome files included, as storedBytes (D9)', async () => {
      const a = output('card-stored-a')
      const failing = output('worker-fails')
      await send(request(turn([bash('toolu_a', 'npm test', a), bash('toolu_f', 'npm run lint', failing)])))
      // One original and two outcome files: the whole result has an outcome file and no original.
      expect(files('.txt')).toHaveLength(1)
      expect(files('.outcome')).toHaveLength(2)
      expect(kpi('storedFiles')).toBe(1)
      const all = fs.readdirSync(folder())
      expect(kpi('storedBytes')).toBe(folderBytes(all))
      expect(folderBytes(all)).toBeGreaterThan(folderBytes(files('.txt')))

      const b = output('card-stored-b')
      await send(request(turn([bash('toolu_b', 'npm test', b)])))
      expect(kpi('storedFiles')).toBe(2)
      expect(kpi('storedBytes')).toBe(folderBytes(fs.readdirSync(folder())))
    })

    it('measures the wait over requests that awaited the worker or the disk: one with no eligible result adds no sample, a fast one lowers the average and not the longest (US4-4)', async () => {
      reply = body => ({ delayMs: 250, json: chatAnswer(DEFAULT_FACTS, { prompt_tokens: promptTokensOf(body), completion_tokens: 7 }) })
      await send(request(turn([bash('toolu_slow', 'npm test', output('card-slow'))])))
      const longest = kpi('waitMaxMs') as number
      const average = kpi('waitAvgMs') as number
      // A timer set for 250 ms may fire a little early; the wait is not far over it either.
      expect(longest).toBeGreaterThanOrEqual(200)
      expect(longest).toBeLessThan(5_000)
      expect(Math.abs(average - longest)).toBeLessThanOrEqual(1)

      // Twelve requests with nothing to condense wait for nothing, and are not samples.
      for (let i = 0; i < 12; i++) await send(request(turn([bash(`toolu_small_${i}`, 'ls', rows(10 + i))])))
      expect(kpi('waitMaxMs')).toBe(longest)
      expect(kpi('waitAvgMs')).toBe(average)

      // A worker that answers at once: a second sample, far under the first.
      reply = body => ({ json: chatAnswer(DEFAULT_FACTS, { prompt_tokens: promptTokensOf(body), completion_tokens: 7 }) })
      await send(request(turn([bash('toolu_fast', 'npm test', output('card-fast'))])))
      expect(kpi('waitMaxMs')).toBe(longest)
      expect(kpi('waitAvgMs') as number).toBeLessThan(longest - 50)
    })

    it('resets every counter, the events included, and counts again from zero; the stored files stay as they are on disk (resetStats)', async () => {
      const a = output('card-reset')
      const body = request(turn([bash('toolu_1', 'npm test', a), bash('toolu_2', 'npm run lint', output('worker-fails'))]))
      await send(body)
      expect(kpi('condensed')).toBe(1)
      expect(m.mod.getStats().recentEvents.length).toBeGreaterThan(0)
      const stored = { files: kpi('storedFiles'), bytes: kpi('storedBytes') }
      expect(stored.files).toBe(1)

      m.mod.resetStats()
      for (const key of NUMERIC.filter(key => key !== 'storedFiles' && key !== 'storedBytes')) expect(kpi(key), key).toBe(0)
      expect(String(kpi('whole'))).not.toMatch(/\d/)
      expect(m.mod.getStats().recentEvents).toEqual([])
      // The folder was not touched, so its totals still describe it.
      expect({ files: kpi('storedFiles'), bytes: kpi('storedBytes') }).toEqual(stored)
      expect(kpi('storedBytes')).toBe(folderBytes(fs.readdirSync(folder())))

      // The same request again: both results are remembered, so no worker call, and the counts start at zero.
      const asked = worker.received.length
      await send(body)
      expect(worker.received).toHaveLength(asked)
      expect(kpi('condensed')).toBe(1)
      expect(kpi('whole')).toBe('worker-failed 1')
      expect(kpi('workerIn')).toBe(0)
      expect(kpi('workerOut')).toBe(0)
    })

    describe('what the module shows and writes of a result (FR-014, US4-6; D2 and D9 decide what is allowed on disk)', () => {
      /** In the tool output, and nowhere else unless the worker quotes it. */
      const MARK = 'CARD-MARK-77e1'
      /** In the worker's answer, so in the condensed text and nowhere else. */
      const FACT_MARK = 'FACT-ZEBRA-4417'

      /** Files under the data directory whose content holds `marker`, relative to it, sorted. */
      const holders = (marker: string, dir: string = root): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) return holders(marker, full)
        return fs.readFileSync(full, 'utf8').includes(marker) ? [relative(root, full).split(sep).join('/')] : []
      }).sort()

      it.each([false, true])('keeps the marker out of every log line, event and the card, and puts it on disk only in the stored original and, when the worker quotes it, the outcome file (worker quotes it: %s)', async quoted => {
        process.env.LLM_FW_LOG_LEVEL = 'debug'
        const sinks = (['log', 'info', 'debug', 'error'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
        reply = body => {
          if (JSON.stringify(body).includes('worker-fails')) return { status: 500 }
          const facts = quoted ? `${FACT_MARK}: ${MARK} is in the output. 3 tests failed.` : `${FACT_MARK}: 3 tests failed.`
          return { json: chatAnswer(facts, { prompt_tokens: promptTokensOf(body), completion_tokens: 12 }) }
        }
        const marked = `${output('card-marked')}\n${MARK}`
        const failing = `${output('worker-fails')}\n${MARK}`
        const dry = `${output('card-marked-dry')}\n${MARK}`

        const live = await send(request(turn([bash('toolu_1', 'npm test', marked), bash('toolu_2', 'npm run lint', failing)])))
        const dryRun = await send(request(turn([bash('toolu_3', 'npm run build', dry)])), { dryRun: true })
        const events = [...live.events, ...dryRun.events]

        // Not a module that did nothing: the first result is condensed with the worker's facts, the second was left whole with a warning, the dry run counted.
        expect(live.results[0]!.startsWith('[llm-fw: tool output condensed')).toBe(true)
        expect(live.results[0]).toContain(FACT_MARK)
        expect(live.results[1]).toBe(failing)
        expect(shuntWarnings().length).toBeGreaterThanOrEqual(1)
        expect(events.length).toBeGreaterThan(0)
        expect(kpi('condensed')).toBe(2)

        const shown = JSON.stringify({ stats: m.mod.getStats(), events, console: [...sinks, warn].map(spy => spy.mock.calls) })
        for (const text of [MARK, FACT_MARK, 'tool output condensed', '3 tests failed']) expect(shown.includes(text), text).toBe(false)

        const original = `tool-results/${sha256(marked)}.txt`
        const outcome = `tool-results/${keyOf('Bash', marked)}.outcome`
        expect(holders(MARK)).toEqual((quoted ? [original, outcome] : [original]).sort())
        // The worker's words are in the outcome file, and the stored original holds the output and nothing added.
        expect(holders(FACT_MARK)).toEqual([outcome])
        expect(fs.readFileSync(join(root, original), 'utf8')).toBe(marked)
      })
    })
  })
})
