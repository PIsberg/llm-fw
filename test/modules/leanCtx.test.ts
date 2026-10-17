import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { LeanCtxModule, isFileRead, type LeanCtxSpawn } from '../../src/modules/builtin/leanCtx.js'
import { AnsiStripModule } from '../../src/modules/builtin/ansiStrip.js'
import { ModuleManager } from '../../src/modules/registry.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import type { LeanCtxConfig } from '../../src/types.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const FAKE = fileURLToPath(new URL('./fixtures/fake-lean-ctx.mjs', import.meta.url))
const log = (n: number, word = 'step') => Array.from({ length: n }, (_, i) => `[INFO] ${word} ${i + 1}`).join('\n')
const LOG = log(40)
const COMPRESSED = '[INFO] step 1\n[INFO] step 2\n[38 lines omitted]'

type Call = { id: string; name: string; input: Record<string, unknown>; out: string }
const turn = (calls: Call[]) => [
  { role: 'assistant', content: calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) },
  { role: 'user', content: calls.map(c => ({ type: 'tool_result', tool_use_id: c.id, content: c.out })) },
]
const bash = (id: string, command: string, out = LOG): Call => ({ id, name: 'Bash', input: { command }, out })
const sse = (...events: unknown[]) => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: Buffer.from(events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')),
})

describe('isFileRead', () => {
  const skip = DEFAULT_CONFIG.modules!.leanCtx!.skipCommands

  it('flags a command that prints a file, anywhere in a pipeline or a compound command', () => {
    for (const command of [
      'cat src/a.ts',
      "sed -n '200,480p' Corpus.java",
      'npm test 2>&1 | tail -30',
      'cd /c/dev/x && head -50 CHANGELOG.md',
      'Get-Content .\\notes.md',
      "bash -lc 'cat x'",
      '/usr/bin/cat x',
      'grep -rn foo src',
      'git show HEAD:src/a.ts',
      'git diff main',
      'for f in a b; do nl $f.java; done',
    ]) expect(isFileRead(command, skip), command).toBe(true)
  })

  it('passes a command whose output is not a file', () => {
    for (const command of ['mvn -q verify', 'npm run build', 'git status --short', 'ls -la', 'cargo build --release', 'gh pr checks 74'])
      expect(isFileRead(command, skip), command).toBe(false)
  })
})

// Each test starts a process. Under a full parallel run, starting one took
// over 5 s, vitest's default, so the budget and the timeout leave room.
const START_BUDGET_MS = 25_000

describe('LeanCtxModule', { timeout: 40_000 }, () => {
  const savedEnv = { ...process.env }
  const modules: LeanCtxModule[] = []
  afterEach(() => {
    for (const mod of modules.splice(0)) mod.close()
    process.env = { ...savedEnv }
  })

  // The fake lean-ctx runs under node with the arguments and environment
  // the module chose; the binary it asked for is recorded.
  function setup(overrides: Partial<LeanCtxConfig> = {}) {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-'))
    process.env.LLM_FW_DIR = dir
    // Absolute, so the lookup accepts it; the stand-in runs whatever it names.
    process.env.LLM_FW_LEAN_CTX_BIN ??= join(dir, 'lean-ctx')
    const logFile = join(dir, 'fake.log')
    const binaries: string[] = []
    const launch: LeanCtxSpawn = (command, args, options) => {
      binaries.push(command)
      return spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...options.env, FAKE_LEAN_CTX_LOG: logFile } })
    }
    // The default 500 ms is for a lean-ctx that is already running.
    const cfg: LeanCtxConfig = { ...structuredClone(DEFAULT_CONFIG.modules!.leanCtx!), enabled: true, timeoutMs: START_BUDGET_MS, ...overrides }
    const mod = new LeanCtxModule(cfg, launch)
    modules.push(mod)
    const entries = () => fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { started?: string[]; env?: Record<string, string>; cwd?: string; compress?: string })
      : []
    const send = async (messages: unknown[]) => JSON.parse((await mod.transformRequest(JSON.stringify({ messages }), ctx)).body) as { messages: Array<{ content: Array<{ content: string }> }> }
    return { dir, cfg, mod, binaries, entries, sent: () => entries().filter(e => e.compress !== undefined).map(e => e.compress), send }
  }

  it('compresses the output of a shell command through lean-ctx, without its retrieve instruction', async () => {
    const { mod, send } = setup()
    const out = await send(turn([bash('t1', 'mvn -q verify')]))
    expect(out.messages[1]!.content[0]!.content).toBe(COMPRESSED)
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)
  })

  it('never sends a file read, a tool that is not a shell, a prompt, or a result whose command it does not know', async () => {
    const { send, sent } = setup()
    const out = await send([
      { role: 'user', content: LOG },
      ...turn([
        bash('t1', 'cat src/a.ts'),
        { id: 't2', name: 'Read', input: { file_path: 'a.ts' }, out: LOG },
        bash('t3', 'npm run build', log(40, 'built')),
      ]),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: log(40, 'orphan') }] },
    ])
    expect(out.messages[0]!.content).toBe(LOG)
    expect(out.messages[2]!.content.map(r => r.content)).toEqual([LOG, LOG, '[INFO] built 1\n[INFO] built 2\n[38 lines omitted]'])
    expect(out.messages[3]!.content[0]!.content).toBe(log(40, 'orphan'))
    expect(sent()).toEqual([log(40, 'built')])
  })

  // Claude Code through the proxy keeps a server-side thread: the next
  // request carries the results and not the calls, which only the streamed
  // response named, with the command spread over input_json_delta events.
  it('learns the command from a streamed response when a thread continuation carries only the results', async () => {
    const { mod, send } = setup()
    mod.observeResponse('{}', ctx, sse(
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' test"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_c', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"cat a.ts"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ))
    const out = await send([{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_b', content: LOG },
      { type: 'tool_result', tool_use_id: 'toolu_c', content: LOG },
    ] }])
    expect(out.messages[0]!.content.map(r => r.content)).toEqual([COMPRESSED, LOG])
  })

  // A rewrite must be a function of the slot and what precedes it, or the
  // provider's prompt cache misses and a signed thinking block is rejected.
  it('gives a result the same bytes on every later turn, so each request is a prefix of the next', async () => {
    const { send } = setup()
    const first = turn([bash('t1', 'mvn -q verify')])
    const out1 = await send(first)
    const out2 = await send([...first, { role: 'assistant', content: 'next' }, ...turn([bash('t2', 'npm test', log(40, 'test'))])])
    expect(out2.messages.slice(0, out1.messages.length)).toEqual(out1.messages)
    expect(out2.messages[4]!.content[0]!.content).toBe('[INFO] test 1\n[INFO] test 2\n[38 lines omitted]')
  })

  it('keeps a result it could not compress in time uncompressed on later turns, and does not ask again', async () => {
    const { cfg, send, sent } = setup()
    // Started and answering first, so the timeout below is lean-ctx's answer, not its start.
    await send(turn([bash('t0', 'mvn -q verify')]))
    cfg.timeoutMs = 300
    const slow = log(40, 'SLOW')
    const history = turn([bash('t1', 'npm test', slow)])
    expect((await send(history)).messages[1]!.content[0]!.content).toBe(slow)
    await new Promise(resolve => setTimeout(resolve, 1600))
    expect((await send(history)).messages[1]!.content[0]!.content).toBe(slow)
    expect(sent()).toEqual([LOG, slow])
  })

  it('forwards the request unchanged when lean-ctx cannot be started', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-'))
    process.env.LLM_FW_DIR = dir
    process.env.LLM_FW_LEAN_CTX_BIN = join(dir, 'no-such-lean-ctx')
    const mod = new LeanCtxModule({ ...structuredClone(DEFAULT_CONFIG.modules!.leanCtx!), enabled: true })
    modules.push(mod)
    const body = JSON.stringify({ messages: turn([bash('t1', 'mvn -q verify')]) })
    const res = await mod.transformRequest(body, ctx)
    expect(res.modified).toBe(false)
    expect(res.body).toBe(body)
  })

  it('says once that lean-ctx is missing, not on every retry', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-'))
    process.env.LLM_FW_DIR = dir
    const missing = join(dir, 'no-such-lean-ctx')
    let starts = 0
    const launch: LeanCtxSpawn = (_command, args, options) => { starts++; return spawn(missing, args, options) }
    const mod = new LeanCtxModule({ ...structuredClone(DEFAULT_CONFIG.modules!.leanCtx!), enabled: true }, launch)
    modules.push(mod)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now')
    try {
      const body = JSON.stringify({ messages: turn([bash('t1', 'mvn -q verify')]) })
      clock.mockReturnValue(now)
      await mod.transformRequest(body, ctx)
      clock.mockReturnValue(now + 61_000)
      await mod.transformRequest(JSON.stringify({ messages: turn([bash('t2', 'npm test', log(40, 'test'))]) }), ctx)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(starts).toBe(2)
      expect(warn.mock.calls.filter(([line]) => String(line).includes('lean-ctx stopped'))).toHaveLength(1)
    } finally {
      clock.mockRestore()
      warn.mockRestore()
    }
  })

  it('starts lean-ctx again after it stops, once for requests that arrive together', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-'))
    process.env.LLM_FW_DIR = dir
    const children: ReturnType<typeof spawn>[] = []
    const launch: LeanCtxSpawn = (_command, args, options) => {
      const child = spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...options.env, FAKE_LEAN_CTX_LOG: join(dir, 'fake.log') } })
      children.push(child)
      return child
    }
    const mod = new LeanCtxModule({ ...structuredClone(DEFAULT_CONFIG.modules!.leanCtx!), enabled: true, timeoutMs: START_BUDGET_MS }, launch)
    modules.push(mod)
    const send = async (id: string, word: string) =>
      JSON.parse((await mod.transformRequest(JSON.stringify({ messages: turn([bash(id, 'npm test', log(40, word))]) }), ctx)).body).messages[1].content[0].content as string
    expect(await send('t1', 'one')).toContain('[38 lines omitted]')
    await new Promise(resolve => { children[0]!.once('exit', resolve); children[0]!.kill() })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    try {
      const [a, b] = await Promise.all([send('t2', 'two'), send('t3', 'three')])
      expect(children).toHaveLength(2)
      expect([a, b]).toEqual(['[INFO] two 1\n[INFO] two 2\n[38 lines omitted]', '[INFO] three 1\n[INFO] three 2\n[38 lines omitted]'])
    } finally {
      clock.mockRestore()
    }
  })

  it('stops a lean-ctx that never answers, and starts another later', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-'))
    process.env.LLM_FW_DIR = dir
    process.env.LLM_FW_LEAN_CTX_BIN = join(dir, 'lean-ctx')
    const children: ReturnType<typeof spawn>[] = []
    // Runs, listens on nothing, answers nothing.
    const launch: LeanCtxSpawn = (_command, _args, options) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options)
      children.push(child)
      return child
    }
    const mod = new LeanCtxModule({ ...structuredClone(DEFAULT_CONFIG.modules!.leanCtx!), enabled: true, timeoutMs: 300 }, launch)
    modules.push(mod)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const send = (id: string) => mod.transformRequest(JSON.stringify({ messages: turn([bash(id, 'npm test', log(40, id))]) }), ctx)
      expect((await send('a')).modified).toBe(false)
      const exited = new Promise(resolve => children[0]!.once('exit', resolve))
      clock.mockReturnValue(now + 31_000)
      await exited
      clock.mockReturnValue(now + 61_000)
      expect((await send('b')).modified).toBe(false)
      expect(children).toHaveLength(2)
    } finally {
      clock.mockRestore()
      warn.mockRestore()
    }
  })

  // llm-fw is started inside repositories it did not write, and Windows
  // looks for a bare program name in the working directory first.
  it('runs lean-ctx only from an absolute PATH entry or an absolute LLM_FW_LEAN_CTX_BIN', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-'))
    process.env.LLM_FW_DIR = dir
    delete process.env.LLM_FW_LEAN_CTX_BIN
    const name = process.platform === 'win32' ? 'lean-ctx.exe' : 'lean-ctx'
    const plant = (folder: string) => {
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(join(folder, name), '')
      fs.chmodSync(join(folder, name), 0o755)
    }
    const binaries: string[] = []
    const launch: LeanCtxSpawn = (command, args, options) => {
      binaries.push(command)
      return spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...options.env, FAKE_LEAN_CTX_LOG: join(dir, 'fake.log') } })
    }
    const attempt = async (id: string) => {
      const mod = new LeanCtxModule({ ...structuredClone(DEFAULT_CONFIG.modules!.leanCtx!), enabled: true, timeoutMs: START_BUDGET_MS }, launch)
      modules.push(mod)
      return JSON.parse((await mod.transformRequest(JSON.stringify({ messages: turn([bash(id, 'npm test', log(40, id))]) }), ctx)).body).messages[1].content[0].content as string
    }
    // A relative PATH entry, as `.` or a repository's bin/ would be, is not searched.
    plant(join(dir, 'relative-bin'))
    process.env.PATH = `relative-bin${delimiter}${join(dir, 'empty')}`
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      expect(await attempt('a')).toBe(log(40, 'a'))
    } finally {
      process.chdir(cwd)
    }
    process.env.LLM_FW_LEAN_CTX_BIN = join('bin', name)
    expect(await attempt('b')).toBe(log(40, 'b'))
    expect(binaries).toEqual([])

    delete process.env.LLM_FW_LEAN_CTX_BIN
    plant(join(dir, 'absolute-bin'))
    process.env.PATH = `relative-bin${delimiter}${join(dir, 'absolute-bin')}`
    expect(await attempt('c')).toBe('[INFO] c 1\n[INFO] c 2\n[38 lines omitted]')
    expect(binaries).toEqual([join(dir, 'absolute-bin', name)])
  })

  // The port is picked before lean-ctx binds it. A process that takes it in
  // between answers /health while lean-ctx, unable to bind, exits.
  it('sends nothing to a process that took the port lean-ctx was given', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-'))
    process.env.LLM_FW_DIR = dir
    process.env.LLM_FW_LEAN_CTX_BIN = join(dir, 'lean-ctx')
    const received: string[] = []
    let impostor: Server | undefined
    const launch: LeanCtxSpawn = (_command, args, options) => {
      const port = Number(args.find(a => a.startsWith('--port='))!.slice(7))
      impostor = createServer((req, res) => {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          if (req.url === '/v1/compress') received.push(body)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(req.url === '/health' ? 'ok' : JSON.stringify({ messages: [{ role: 'tool', content: 'impostor' }] }))
        })
      }).listen(port, '127.0.0.1')
      return spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...options.env, FAKE_LEAN_CTX_LOG: join(dir, 'fake.log') } })
    }
    const mod = new LeanCtxModule({ ...structuredClone(DEFAULT_CONFIG.modules!.leanCtx!), enabled: true, timeoutMs: START_BUDGET_MS }, launch)
    modules.push(mod)
    try {
      const out = JSON.parse((await mod.transformRequest(JSON.stringify({ messages: turn([bash('t1', 'mvn -q verify')]) }), ctx)).body)
      expect(out.messages[1].content[0].content).toBe(LOG)
      expect(received).toEqual([])
    } finally {
      impostor?.close()
    }
  })

  it('logs why lean-ctx stopped, but not its stderr once it has seen tool output', async () => {
    const { send } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await send(turn([bash('t1', 'mvn -q verify')]))
      await send(turn([bash('t2', 'npm test', log(40, 'CRASH token=sk-live-0123'))]))
      await new Promise(resolve => setTimeout(resolve, 300))
      const lines = warn.mock.calls.map(([line]) => String(line)).filter(line => line.includes('lean-ctx stopped'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('exit 3')
      expect(lines[0]).not.toContain('sk-live-0123')
    } finally {
      warn.mockRestore()
    }
  })

  it('starts lean-ctx with telemetry off, its own folders under LLM_FW_DIR, its own token, and nothing else from the environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-for-lean-ctx'
    process.env.LLM_FW_LEAN_CTX_BIN = '/opt/lean-ctx/bin/lean-ctx'
    const { dir, binaries, entries, send } = setup()
    await send(turn([bash('t1', 'mvn -q verify')]))
    const start = entries().find(e => e.started)!
    expect(binaries).toEqual(['/opt/lean-ctx/bin/lean-ctx'])
    expect(start.started).toEqual(['proxy', 'start', expect.stringMatching(/^--port=\d+$/)])
    const env = start.env!
    expect(env.DO_NOT_TRACK).toBe('1')
    expect(env.LEAN_CTX_TELEMETRY).toBe('off')
    for (const key of ['LEAN_CTX_DATA_DIR', 'LEAN_CTX_CONFIG_DIR', 'LEAN_CTX_STATE_DIR', 'LEAN_CTX_CACHE_DIR']) {
      expect(env[key]!.startsWith(join(dir, 'lean-ctx')), key).toBe(true)
    }
    expect(env.LEAN_CTX_PROXY_TOKEN!.length).toBeGreaterThanOrEqual(32)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.LLM_FW_DIR).toBeUndefined()
    expect(start.cwd).toBe(join(dir, 'lean-ctx'))
    // lean-ctx stores the original of every lossy result under
    // <state>/tee/ and gives up quietly when it cannot create that folder
    // (ccr.rs, storage.rs). A file in its place keeps tool output off disk;
    // leanCtx.real.test.ts checks the effect against the real binary.
    expect(fs.statSync(join(env.LEAN_CTX_STATE_DIR!, 'tee')).isFile()).toBe(true)
  })

  // The proxy and the gateway go through ModuleManager, which hands payload
  // modules one shared parsed body and must await the lean-ctx call first.
  it('compresses through ModuleManager, behind a module that rewrites the same body', async () => {
    const { mod } = setup()
    const mgr = new ModuleManager(undefined, false)
    mgr.register(new AnsiStripModule({ enabled: true }))
    mgr.register(mod)
    const res = await mgr.transformRequest(JSON.stringify({ messages: turn([bash('t1', 'mvn -q verify', `\u001b[32m${LOG}\u001b[0m`)]) }), ctx)
    expect(JSON.parse(res.body).messages[1].content[0].content).toBe(COMPRESSED)
  })

  it('takes tools and skipCommands live', async () => {
    const { cfg, send } = setup()
    const history = turn([bash('t1', 'cat build.log')])
    expect((await send(history)).messages[1]!.content[0]!.content).toBe(LOG)
    cfg.skipCommands = cfg.skipCommands.filter(c => c !== 'cat')
    expect((await send(history)).messages[1]!.content[0]!.content).toBe(COMPRESSED)
    cfg.tools = []
    const other = turn([bash('t2', 'npm run lint', log(40, 'lint'))])
    expect((await send(other)).messages[1]!.content[0]!.content).toBe(log(40, 'lint'))
  })
})
