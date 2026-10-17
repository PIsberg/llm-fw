/**
 * Comparison stage of the tool result shunt (specs/001-tool-result-shunt: US5,
 * FR-020, SC-007): the same tasks run through the real agent twice, once with
 * the module off and once on, and the two runs set side by side.
 *
 * THIS STAGE SPENDS MONEY. Every run is a `claude -p` session on a paid model,
 * sent through a proxy of its own. It runs only with `--approve-spend` (plan
 * D7); without it nothing is started and the report says the stage was not run
 * (US5-4). test/eval/shuntCompare.test.ts is the executable spec of everything
 * but `main`: it passes the runner in and reads recorded stream-json, so it
 * spends nothing.
 *
 * Usage:
 *   npm run eval:shunt:compare -- --approve-spend --repo <another repository> \
 *     --worker-url http://127.0.0.1:11434 --worker-model qwen2.5:3b \
 *     [--tasks test/eval/shunt/compare-tasks.json] [--max-budget-usd 2] [--out report.json]
 *
 * Method (.specify/projects/llm-fw/token-savings-findings.md, "Billed A/B"):
 * one ProxyServer on spare ports with a scratch LLM_FW_DIR and its own CA, in
 * enforce mode with the shipped defaults (never `loadConfig`, which reads the
 * operator's files); the shunt's live switch off or on per arm; the agent spawned
 * asynchronously in `--repo` with HTTPS_PROXY and NODE_EXTRA_CA_CERTS set for the
 * child only. Runs go one at a time, the two arms of a task in alternating order,
 * so the shared proxy, the live switch and the prompt cache's warm-up favour
 * neither arm. Tokens are compared, not billed cost, and only over tasks that
 * completed in both arms; correctness is scored too.
 *
 * `--repo` must be another repository: enforce mode refuses reads of llm-fw's own
 * detection docs and source (#349). Set LLM_FW_MODEL_DIR to the detection models'
 * cache, or the models download into the scratch directory. The child may run
 * `awk` (the only command the tasks use) and the read and search tools, in `--repo`,
 * and nothing else (`claudeArgs`); it reads stored originals from the scratch
 * directory. `--repo` may not hold `.claude/settings.json` or
 * `.claude/settings.local.json`, which the child would load (`checkRepoSettings`).
 * It is started with
 * `--no-session-persistence`, so no run lands in ~/.claude/projects, the folder
 * the replay stage reads.
 */
import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** One task: the prompt the agent gets and the regex its final answer has to match to count as correct. */
export interface CompareTask {
  id: string
  prompt: string
  expect: string
}

/** What one agent run did: read off its stream-json. */
export interface ArmRun {
  taskId: string
  /** The run ended with a successful result: not cut off, not out of turns, not an error. */
  completed: boolean
  /** Completed, and the final answer matches the task's `expect`. */
  correct: boolean
  /** Input tokens plus cache writes plus cache reads, over every turn of the run. */
  promptTokens: number
  cacheWrites: number
  cacheReads: number
  /** Assistant turns, one per distinct assistant message. */
  turns: number
  /** `tool_use` calls whose input names a stored original (64 hex digits and `.txt`). */
  storedReads: number
}

/** One arm's figures over the tasks completed in both arms. */
export interface ArmTotals {
  promptTokens: number
  cacheWrites: number
  cacheReads: number
  turns: number
  /** Tasks answered correctly. */
  correct: number
  storedReads: number
}

/**
 * The comparison, as numbers and as sentences.
 *
 * - `ran`: false when the spend was not approved (US5-4);
 * - `tasksCompared`: tasks completed in both arms, the only ones any figure counts;
 * - `off` and `on`: the arm's totals over those tasks;
 * - `net.promptTokensSaved`: `off.promptTokens - on.promptTokens`, negative for a loss;
 * - `lines`: the report as sentences, one per entry, for the guide;
 * - `tasksRun`, `completed`: the tasks either arm ran, and how many each arm completed,
 *   so a comparison over few tasks says how many were left out;
 * - `runs`: every run of each arm, completed or not.
 */
export interface CompareReport {
  ran: boolean
  tasksCompared: number
  off: ArmTotals
  on: ArmTotals
  net: { promptTokensSaved: number }
  lines: string[]
  tasksRun: number
  completed: { off: number; on: number }
  runs: { off: ArmRun[]; on: ArmRun[] }
}

/** How many tasks completed in both arms SC-007 asks for before the comparison says anything about a workload. */
const MIN_TASKS = 4

/** A stored original's file name: the SHA-256 of the text, 64 hex digits, and `.txt` (src/modules/shuntStore.ts). */
const STORED_ORIGINAL = /(?<![0-9a-f])[0-9a-f]{64}\.txt/

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A token count of a usage field: a non-negative number, else 0. */
const tokens = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

const figures = (n: number): string => n.toLocaleString('en-US')

/** One line of stream-json as an object; a torn or blank line is not an entry. */
function entryOf(line: string): Obj | undefined {
  if (line.trim() === '') return undefined
  try {
    const entry: unknown = JSON.parse(line)
    return isObj(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

/** Read one run's stream-json (`claude -p --output-format stream-json --verbose`, one JSON object per line). */
export function parseRun(streamJson: string, task: CompareTask): ArmRun {
  // A message written as several entries (one per content block) repeats its id and usage: one turn.
  const turns = new Map<string, { input: number; writes: number; reads: number }>()
  const seenCalls = new Set<string>()
  let anonymous = 0
  let storedReads = 0
  let result: Obj | undefined

  for (const line of streamJson.split('\n')) {
    const entry = entryOf(line)
    if (!entry) continue
    if (entry['type'] === 'result') {
      result = entry
      continue
    }
    if (entry['type'] !== 'assistant') continue
    const message = entry['message']
    if (!isObj(message)) continue

    const id = typeof message['id'] === 'string' ? message['id'] : `anonymous-message-${anonymous++}`
    const usage = message['usage']
    if (isObj(usage)) {
      turns.set(id, {
        input: tokens(usage['input_tokens']),
        writes: tokens(usage['cache_creation_input_tokens']),
        reads: tokens(usage['cache_read_input_tokens']),
      })
    } else if (!turns.has(id)) {
      turns.set(id, { input: 0, writes: 0, reads: 0 })
    }

    // Only the input of a call is a read. The path in a tool result or in what the assistant says is not.
    const content = message['content']
    for (const block of Array.isArray(content) ? content : []) {
      if (!isObj(block) || block['type'] !== 'tool_use') continue
      const callId = typeof block['id'] === 'string' ? block['id'] : `anonymous-call-${anonymous++}`
      if (seenCalls.has(callId)) continue
      seenCalls.add(callId)
      if (STORED_ORIGINAL.test(JSON.stringify(block['input'] ?? null))) storedReads++
    }
  }

  let input = 0
  let cacheWrites = 0
  let cacheReads = 0
  for (const turn of turns.values()) {
    input += turn.input
    cacheWrites += turn.writes
    cacheReads += turn.reads
  }

  const completed = result !== undefined && result['subtype'] === 'success' && result['is_error'] !== true
  const answer = completed && typeof result?.['result'] === 'string' ? result['result'] : ''
  return {
    taskId: task.id,
    completed,
    correct: completed && new RegExp(task.expect).test(answer),
    promptTokens: input + cacheWrites + cacheReads,
    cacheWrites,
    cacheReads,
    turns: turns.size,
    storedReads,
  }
}

const emptyTotals = (): ArmTotals => ({ promptTokens: 0, cacheWrites: 0, cacheReads: 0, turns: 0, correct: 0, storedReads: 0 })

function totalsOf(runs: ArmRun[]): ArmTotals {
  const totals = emptyTotals()
  for (const run of runs) {
    totals.promptTokens += run.promptTokens
    totals.cacheWrites += run.cacheWrites
    totals.cacheReads += run.cacheReads
    totals.turns += run.turns
    totals.correct += run.correct ? 1 : 0
    totals.storedReads += run.storedReads
  }
  return totals
}

function armLine(label: string, totals: ArmTotals, tasks: number, withStoredReads: boolean): string {
  return `${label}: ${figures(totals.promptTokens)} prompt tokens (${figures(totals.cacheWrites)} cache writes, ${figures(totals.cacheReads)} cache reads), `
    + `${figures(totals.turns)} turns, ${totals.correct} of ${tasks} tasks answered correctly`
    + (withStoredReads ? `, ${figures(totals.storedReads)} reads of a stored original.` : '.')
}

/** The report as sentences: the figures of each arm, the net even when it is a loss, and the verdict on correctness. */
function describe(c: { tasksRun: number; tasksCompared: number; completed: { off: number; on: number }; off: ArmTotals; on: ArmTotals; saved: number }): string[] {
  const lines = [`Tasks run: ${c.tasksRun}. Completed with the module off: ${c.completed.off}, with it on: ${c.completed.on}. Completed in both, and so compared: ${c.tasksCompared}.`]
  if (c.tasksCompared === 0) {
    lines.push('No task completed in both arms, so there is nothing to compare.')
    return lines
  }
  const m = c.tasksCompared
  lines.push(armLine('Module off', c.off, m, false))
  lines.push(armLine('Module on', c.on, m, true))

  const share = c.off.promptTokens > 0 ? ` (${(Math.abs(c.saved) / c.off.promptTokens * 100).toFixed(1)}% of the ${figures(c.off.promptTokens)} the module-off arm used)` : ''
  if (c.saved > 0) lines.push(`Net: the module saved ${figures(c.saved)} prompt tokens${share}.`)
  else if (c.saved < 0) lines.push(`Net: a loss of ${figures(-c.saved)} prompt tokens${share}; the module used more than it saved on this workload.`)
  else lines.push('Net: no change in prompt tokens.')

  if (c.on.correct < c.off.correct) {
    lines.push(`The module-on arm answered ${c.on.correct} of ${m} tasks correctly against ${c.off.correct} with the module off: the module is not recommended for this workload.`)
  } else if (c.on.correct === c.off.correct) {
    lines.push(`The module-on arm answered as many tasks correctly as the module-off arm: ${c.on.correct} of ${m}.`)
  } else {
    lines.push(`The module-on arm answered ${c.on.correct} of ${m} tasks correctly against ${c.off.correct} with the module off.`)
  }
  if (m < MIN_TASKS) {
    lines.push(`Only ${m} tasks completed in both arms; at least ${MIN_TASKS} are needed before this says anything about a workload.`)
  }
  return lines
}

/** Set the two arms side by side, over the tasks completed in both. */
export function summarise(off: ArmRun[], on: ArmRun[]): CompareReport {
  const onById = new Map(on.map(run => [run.taskId, run]))
  const offPaired: ArmRun[] = []
  const onPaired: ArmRun[] = []
  for (const run of off) {
    const other = onById.get(run.taskId)
    if (run.completed && other?.completed) {
      offPaired.push(run)
      onPaired.push(other)
    }
  }
  const offTotals = totalsOf(offPaired)
  const onTotals = totalsOf(onPaired)
  const saved = offTotals.promptTokens - onTotals.promptTokens
  const completed = { off: off.filter(run => run.completed).length, on: on.filter(run => run.completed).length }
  const tasksRun = new Set([...off, ...on].map(run => run.taskId)).size
  return {
    ran: true,
    tasksCompared: offPaired.length,
    off: offTotals,
    on: onTotals,
    net: { promptTokensSaved: saved },
    lines: describe({ tasksRun, tasksCompared: offPaired.length, completed, off: offTotals, on: onTotals, saved }),
    tasksRun,
    completed,
    runs: { off, on },
  }
}

/** A task that must not reach a paid run: a repeated id (runs are paired by it) or an `expect` that is empty or not a regular expression. */
function checkTasks(tasks: CompareTask[]): void {
  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`task id ${task.id} appears twice; the arms are paired by id`)
    ids.add(task.id)
    if (task.expect === '') throw new Error(`task ${task.id}: expect is empty, so every answer would count as correct`)
    try {
      new RegExp(task.expect)
    } catch (err) {
      throw new Error(`task ${task.id}: expect is not a regular expression: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

const notRun = (): CompareReport => ({
  ran: false,
  tasksCompared: 0,
  off: emptyTotals(),
  on: emptyTotals(),
  net: { promptTokensSaved: 0 },
  lines: ['The comparison stage was not run. It runs the agent on a paid model, so it waits for the maintainer\'s approval (--approve-spend); no agent was started and there are no comparison figures.'],
  tasksRun: 0,
  completed: { off: 0, on: 0 },
  runs: { off: [], on: [] },
})

const failedRun = (task: CompareTask): ArmRun => ({
  taskId: task.id, completed: false, correct: false, promptTokens: 0, cacheWrites: 0, cacheReads: 0, turns: 0, storedReads: 0,
})

/**
 * Run every task in both arms through `run`, one run at a time, and summarise.
 * The two arms of a task go in alternating order. A run that fails to start counts
 * as not completed and the others go on. Without `approved` nothing is run and the
 * report says the stage was not run (FR-020, US5-4).
 */
export async function compare(opts: {
  approved: boolean
  tasks: CompareTask[]
  run: (task: CompareTask, arm: 'off' | 'on') => Promise<string>
}): Promise<CompareReport> {
  checkTasks(opts.tasks)
  if (!opts.approved) return notRun()

  const runs: Record<'off' | 'on', ArmRun[]> = { off: [], on: [] }
  for (const [i, task] of opts.tasks.entries()) {
    const order: Array<'off' | 'on'> = i % 2 === 0 ? ['off', 'on'] : ['on', 'off']
    for (const arm of order) {
      try {
        runs[arm].push(parseRun(await opts.run(task, arm), task))
      } catch {
        runs[arm].push(failedRun(task))
      }
    }
  }
  return summarise(runs.off, runs.on)
}

// ---------------------------------------------------------------------------
// main: the billed run. Nothing below runs without --approve-spend.
// ---------------------------------------------------------------------------

const DEFAULT_TASKS = fileURLToPath(new URL('./compare-tasks.json', import.meta.url))
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
/** Longest one run may take before it is killed and counted as not completed. */
const RUN_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_BUDGET_USD = 2

/** The value after `--name`, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function parseTasks(value: unknown): CompareTask[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('the tasks file must hold a non-empty JSON array')
  return value.map((item: unknown, i) => {
    if (!isObj(item) || typeof item['id'] !== 'string' || typeof item['prompt'] !== 'string' || typeof item['expect'] !== 'string'
      || item['id'] === '' || item['prompt'] === '') {
      throw new Error(`task ${i} needs a string id, prompt and expect`)
    }
    return { id: item['id'], prompt: item['prompt'], expect: item['expect'] }
  })
}

/** A port nothing listens on now. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolvePort(port))
    })
  })
}

/**
 * The environment of the child only: this proxy and its CA, and no other proxy setting.
 *
 * Everything else in the parent's environment is passed through, API credentials included. An
 * allowlist would be tighter, but which variables `claude -p` needs to authenticate and to run
 * the shell cannot be verified without a paid run, and a wrong list fails every run. Until one
 * has been made, the limits on the child are the tool list (`claudeArgs`) and the settings
 * check (`checkRepoSettings`), not this environment.
 */
function childEnv(proxyPort: number, caCertPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(?:https?_proxy|all_proxy|no_proxy|node_extra_ca_certs|llm_fw_dir)$/i.test(key)) env[key] = value
  }
  env['HTTPS_PROXY'] = `http://127.0.0.1:${proxyPort}`
  env['NODE_EXTRA_CA_CERTS'] = caCertPath
  return env
}

/**
 * The argument list of one `claude -p` child (test/eval/shuntCompare.test.ts pins it).
 *
 * The shell is limited to the commands test/eval/shunt/compare-tasks.json tells the agent to
 * run, one prefix rule per command: every task runs `awk`. The test derives that set from the
 * tasks file, so a task that needs another command fails there until it is added here. A prefix
 * rule narrows the shell, it is not a sandbox: `awk` itself can still start a process. The
 * child's other tools read and search; none writes.
 */
export function claudeArgs(scratch: string, maxBudgetUsd: number): string[] {
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    // Project settings only, and `checkRepoSettings` refuses a `--repo` that has any. Do not widen
    // this to user settings, and do not drop it for none: user settings on this machine deny the
    // native Read tool (lean-ctx), which would leave the child unable to read a stored original.
    '--setting-sources', 'project', '--strict-mcp-config',
    // A run is not saved where the replay stage reads recorded sessions.
    '--no-session-persistence',
    '--max-budget-usd', String(maxBudgetUsd),
    // The scratch folder holds the stored originals.
    '--allowedTools', 'Bash(awk:*),Read,Grep,Glob',
    '--add-dir', scratch,
  ]
}

/** The project settings files `--setting-sources project` loads from the directory the child starts in. */
const PROJECT_SETTINGS = ['settings.json', 'settings.local.json']

/**
 * Refuses a repository that carries project settings of its own. The child loads them
 * (`--setting-sources project`), and a settings file can declare hooks, which run commands, and
 * permissions that widen the tool allowlist of `claudeArgs`. Only files directly under
 * `<repo>/.claude` are looked for; a settings file in a parent directory is not.
 */
export function checkRepoSettings(repo: string): void {
  for (const name of PROJECT_SETTINGS) {
    const file = join(repo, '.claude', name)
    if (fs.existsSync(file)) {
      throw new Error(`--repo holds ${file}: the agent would load that repository's hooks and permissions (--setting-sources project). Name a repository without it`)
    }
  }
}

/** One `claude -p` session. Its stream-json on stdout, whatever the exit code; a run that does not start rejects. */
function runClaude(task: CompareTask, repo: string, scratch: string, env: NodeJS.ProcessEnv, maxBudgetUsd: number): Promise<string> {
  const args = claudeArgs(scratch, maxBudgetUsd)
  return new Promise((resolveRun, reject) => {
    // Async: the proxy that answers this child runs in this process, so a blocking spawn would deadlock it.
    const child = spawn('claude', args, { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderrTail = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-2000) })
    child.stdin.on('error', () => undefined)
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS)
    child.once('error', err => {
      clearTimeout(timer)
      reject(new Error(`claude did not start: ${err.message}`))
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0 && stderrTail.trim() !== '') process.stderr.write(`claude exited with ${String(code)}: ${stderrTail.trim()}\n`)
      resolveRun(stdout)
    })
    // The prompt on stdin: no quoting, no command-line length limit.
    child.stdin.end(task.prompt)
  })
}

export async function runApproved(args: string[], tasks: CompareTask[]): Promise<CompareReport> {
  const repoArg = flag(args, '--repo')
  const workerUrl = flag(args, '--worker-url')
  const workerModel = flag(args, '--worker-model')
  if (!repoArg) throw new Error('--repo is required: a repository other than llm-fw for the agent to work in')
  if (!workerUrl || !workerModel) throw new Error('--worker-url and --worker-model are required')
  const budget = Number(flag(args, '--max-budget-usd') ?? DEFAULT_MAX_BUDGET_USD)
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('--max-budget-usd needs a positive number')

  const repo = resolve(repoArg)
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new Error(`--repo ${repo} is not a directory`)
  const inside = relative(PROJECT_ROOT, repo)
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new Error('--repo is inside llm-fw: enforce mode refuses reads of llm-fw\'s own detection docs and source (#349), so name another repository')
  }
  checkRepoSettings(repo)

  const { isLocalWorkerUrl } = await import('../../../src/modules/shuntWorker.js')
  if (!isLocalWorkerUrl(workerUrl)) throw new Error('--worker-url must name this machine (http or https to localhost, 127.x.x.x or ::1)')

  // First, before anything that writes: certificates, stored originals and the audit trail go here, never under the operator's ~/.llm-fw (FR-020).
  const scratch = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shunt-compare-'))
  process.env['LLM_FW_DIR'] = scratch
  const { getLlmFwDir } = await import('../../../src/config/paths.js')
  if (resolve(getLlmFwDir()) !== resolve(scratch)) throw new Error('LLM_FW_DIR did not take effect; refusing to touch the operator\'s directory')
  if (!process.env['LLM_FW_MODEL_DIR']) process.stderr.write('LLM_FW_MODEL_DIR is not set: the detection models download into the scratch directory\n')

  const { DEFAULT_CONFIG } = await import('../../../src/config/config.js')
  const { ProxyServer } = await import('../../../src/proxy/proxy.js')
  const { CertFactory, crlUrlFor } = await import('../../../src/proxy/certs.js')
  const { EventBus } = await import('../../../src/dashboard/eventBus.js')
  const { ModuleManager } = await import('../../../src/modules/registry.js')

  // The shipped defaults in enforce mode with this worker, on spare ports.
  const config = structuredClone(DEFAULT_CONFIG)
  config.enforcement = 'enforce'
  config.proxy.port = await freePort()
  config.proxy.bindHost = '127.0.0.1'
  config.dashboard.port = await freePort()
  config.dashboard.bindHost = '127.0.0.1'
  const shuntConfig = config.modules?.toolResultShunt
  if (!shuntConfig) throw new Error('the shipped defaults have no modules.toolResultShunt')
  shuntConfig.workerUrl = workerUrl
  shuntConfig.workerModel = workerModel
  shuntConfig.enabled = false

  let proxy: InstanceType<typeof ProxyServer> | undefined
  try {
    // The CA carries the CRL address this proxy bakes into its certificates.
    const certs = new CertFactory(crlUrlFor(config.dashboard.bindHost, config.dashboard.port))
    certs.ensureCA()
    const env = childEnv(config.proxy.port, join(scratch, 'ca.crt'))

    const modules = new ModuleManager(config)
    proxy = new ProxyServer(config, new EventBus(config.dashboard), undefined, undefined, modules)
    await proxy.init()
    proxy.start()

    process.stderr.write(`${tasks.length} tasks, both arms: at most ${tasks.length * 2} paid runs of up to ${budget} USD each\n`)
    return await compare({
      approved: true,
      tasks,
      run: async (task, arm) => {
        // The one live switch; no run is in flight while it moves.
        modules.setModuleEnabled('tool-result-shunt', arm === 'on')
        try {
          const stream = await runClaude(task, repo, scratch, env, budget)
          const run = parseRun(stream, task)
          process.stderr.write(`${task.id}/${arm}: ${run.completed ? (run.correct ? 'correct' : 'wrong answer') : 'not completed'}, `
            + `${run.promptTokens} prompt tokens, ${run.turns} turns, ${run.storedReads} stored reads\n`)
          return stream
        } catch (err) {
          process.stderr.write(`${task.id}/${arm}: ${err instanceof Error ? err.message : String(err)}\n`)
          throw err
        }
      },
    })
  } finally {
    await proxy?.stop()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const tasks = parseTasks(JSON.parse(fs.readFileSync(resolve(flag(args, '--tasks') ?? DEFAULT_TASKS), 'utf8')) as unknown)
  const out = flag(args, '--out')

  // Without --approve-spend `compare` is handed no usable runner and nothing else starts.
  const report = args.includes('--approve-spend')
    ? await runApproved(args, tasks)
    : await compare({ approved: false, tasks, run: () => Promise.reject(new Error('the spend was not approved')) })

  const json = JSON.stringify({ date: new Date().toISOString().slice(0, 10), repo: flag(args, '--repo') ?? null, workerModel: flag(args, '--worker-model') ?? null, report }, null, 2)
  if (out) fs.writeFileSync(resolve(out), `${json}\n`, 'utf8')
  else process.stdout.write(`${json}\n`)
  for (const line of report.lines) process.stderr.write(`${line}\n`)
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1) })
}
