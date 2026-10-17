import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { parseRun, summarise, compare, claudeArgs, checkRepoSettings, runApproved, type ArmRun, type CompareTask } from './shunt/compare.js'

// The comparison stage of the tool result shunt (specs/001-tool-result-shunt:
// US5-3, US5-4, FR-020, SC-007): the same tasks run through a real agent with
// the module off and on, and the two arms set side by side. Nothing here
// spends money or spawns an agent: `compare` takes the runner as a parameter,
// and the runs it reads are stream-json fixtures
// (`claude -p --output-format stream-json --verbose`, one JSON object per
// line: `system` init, `assistant` and `user` messages, a closing `result`).
//
// tasks.md T026 leaves `CompareReport` open. The fields these tests read are
// the contract, and the stub test/eval/shunt/compare.ts declares them:
//   ran            false when the spend was not approved (US5-4)
//   tasksCompared  tasks completed in both arms
//   off, on        { promptTokens, cacheWrites, cacheReads, turns, correct, storedReads }
//                  over those tasks only (US5-3)
//   net            { promptTokensSaved }: off minus on, negative for a loss
//   lines          the report as sentences, for the guide
// "Prompt tokens" of a run is its input tokens plus its cache writes plus its
// cache reads, so the cache figures are parts of it, reported again apart.

const fixture = (name: string): string => fs.readFileSync(new URL(`./shunt/fixtures/${name}`, import.meta.url), 'utf8')

const FAILING: CompareTask = { id: 'failing-tests', prompt: 'Run the test suite and name the failing test files.', expect: 'auth\\.spec\\.ts' }

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0)
/** The 64 hex digits of a stored original's file name. */
const hex = (n: number): string => createHash('sha256').update(`stored-original-${n}`).digest('hex')
const textOf = (report: { lines: string[] }): string => report.lines.join('\n')

describe('parseRun: one agent run out of its stream-json (US5-3)', () => {
  const off = fixture('compare-off.jsonl')
  const on = fixture('compare-on.jsonl')

  it('reads a completed run with the module off: prompt tokens, cache writes and reads, turns, a correct answer, no stored original read', () => {
    // Three assistant messages, one of them written as two entries that share a message id and repeat its usage.
    // Prompt tokens are 290 input + 9,300 cache writes + 13,000 cache reads.
    expect(parseRun(off, FAILING)).toEqual({
      taskId: 'failing-tests',
      completed: true,
      correct: true,
      promptTokens: 22_590,
      cacheWrites: 9_300,
      cacheReads: 13_000,
      turns: 3,
      storedReads: 0,
    })
  })

  it('reads a completed run with the module on, and counts the tool calls that read a stored original and nothing else (US5-3)', () => {
    // 300 + 5,800 + 14,500 over four assistant messages. The run reads a stored
    // original twice: a Read of its file and a `sed` of it. The path also sits
    // in a tool result (the condensed text names it) and in an assistant
    // sentence, and neither is a read.
    expect(parseRun(on, FAILING)).toEqual({
      taskId: 'failing-tests',
      completed: true,
      correct: true,
      promptTokens: 20_600,
      cacheWrites: 5_800,
      cacheReads: 14_500,
      turns: 4,
      storedReads: 2,
    })
  })

  it('judges a completed run wrong when its final answer does not match the task\'s expect (US5-3)', () => {
    const run = parseRun(on, { ...FAILING, expect: 'checkout\\.spec\\.ts' })
    expect(run.completed).toBe(true)
    expect(run.correct).toBe(false)
    // The figures do not depend on the answer.
    expect(run.promptTokens).toBe(20_600)
    expect(run.turns).toBe(4)
  })

  it('matches the answer against expect as a regular expression (US5-3)', () => {
    expect(parseRun(on, { ...FAILING, expect: 'auth\\.spec\\.ts and billing\\.spec\\.ts' }).correct).toBe(true)
    expect(parseRun(on, { ...FAILING, expect: '^billing' }).correct).toBe(false)
  })

  it('does not count a run that ran out of turns as completed or correct, though its text says what the task asked for (US5-3)', () => {
    const run = parseRun(fixture('compare-max-turns.jsonl'), FAILING)
    expect(run.taskId).toBe('failing-tests')
    expect(run.completed).toBe(false)
    expect(run.correct).toBe(false)
  })

  it('does not count a run whose stream ends without a result as completed or correct', () => {
    const cut = on.trimEnd().split('\n').slice(0, -1).join('\n')
    expect(cut).toContain('end_turn')
    const run = parseRun(cut, FAILING)
    expect(run.completed).toBe(false)
    expect(run.correct).toBe(false)
  })

  it('does not count a run that ended in an error as completed or correct, even when the error text matches expect', () => {
    const lines = on.trimEnd().split('\n')
    lines[lines.length - 1] = JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, num_turns: 4, session_id: 'sess-on',
      result: 'API Error: auth.spec.ts could not be reached',
      usage: { input_tokens: 300, cache_creation_input_tokens: 5_800, cache_read_input_tokens: 14_500, output_tokens: 230 },
    })
    const run = parseRun(lines.join('\n'), FAILING)
    expect(run.completed).toBe(false)
    expect(run.correct).toBe(false)
  })

  it('counts a stored-original read from the input of a tool call only: a path elsewhere, or a name that is not a stored original, is not one (US5-3)', () => {
    const path = (n: number) => `/home/dev/.llm-fw/tool-results/${hex(n)}.txt`
    const toolUse = (id: string, name: string, input: unknown) => ({
      type: 'assistant',
      message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
    })
    const lines = [
      { type: 'system', subtype: 'init' },
      // Reads of a stored original: the file path of a Read, and a path inside a shell command.
      toolUse('toolu_a', 'Read', { file_path: path(1) }),
      toolUse('toolu_b', 'Bash', { command: `sed -n '10,40p' ${path(2)}` }),
      // Not reads: 63 hex digits, 64 without the extension, another extension, a path of the tool-results folder with a short name.
      toolUse('toolu_c', 'Read', { file_path: `/home/dev/.llm-fw/tool-results/${hex(3).slice(1)}.txt` }),
      toolUse('toolu_d', 'Read', { file_path: `/home/dev/.llm-fw/tool-results/${hex(4)}` }),
      toolUse('toolu_e', 'Read', { file_path: `/home/dev/.llm-fw/tool-results/${hex(5)}.outcome` }),
      toolUse('toolu_f', 'Bash', { command: 'ls /home/dev/.llm-fw/tool-results' }),
      // The path in a result, and in what the assistant says.
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_f', content: `${path(6)}\n${path(7)}` }] } },
      { type: 'assistant', message: { id: 'msg_text', role: 'assistant', content: [{ type: 'text', text: `The original is ${path(8)}` }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 8, result: 'auth.spec.ts', usage: { input_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 } },
    ].map(entry => JSON.stringify(entry)).join('\n')
    expect(parseRun(lines, FAILING).storedReads).toBe(2)
  })
})

describe('summarise: the two arms side by side (US5-3, SC-007)', () => {
  const run = (taskId: string, over: Partial<ArmRun> = {}): ArmRun => ({
    taskId, completed: true, correct: true, promptTokens: 1_000, cacheWrites: 100, cacheReads: 800, turns: 5, storedReads: 0, ...over,
  })
  const ids = ['a', 'b', 'c', 'd']
  const arm = (over: Partial<ArmRun> = {}): ArmRun[] => ids.map(id => run(id, over))

  it('totals each arm\'s figures and counts the tasks answered correctly, with the stored-original reads of the module-on arm (US5-3)', () => {
    const off = [run('a', { promptTokens: 1_000, cacheWrites: 100, cacheReads: 800, turns: 5 }), run('b', { promptTokens: 2_000, cacheWrites: 300, cacheReads: 1_500, turns: 7, correct: false }), run('c', { promptTokens: 500, cacheWrites: 50, cacheReads: 400, turns: 2 })]
    const on = [run('a', { promptTokens: 700, cacheWrites: 60, cacheReads: 600, turns: 6, storedReads: 2 }), run('b', { promptTokens: 1_200, cacheWrites: 90, cacheReads: 1_000, turns: 9, storedReads: 1 }), run('c', { promptTokens: 400, cacheWrites: 40, cacheReads: 350, turns: 2, correct: false })]
    const report = summarise(off, on)
    expect(report.ran).toBe(true)
    expect(report.tasksCompared).toBe(3)
    expect(report.off).toEqual({ promptTokens: 3_500, cacheWrites: 450, cacheReads: 2_700, turns: 14, correct: 2, storedReads: 0 })
    expect(report.on).toEqual({ promptTokens: 2_300, cacheWrites: 190, cacheReads: 1_950, turns: 17, correct: 2, storedReads: 3 })
    expect(report.net.promptTokensSaved).toBe(1_200)
  })

  it('counts only the tasks completed in both arms: a task one arm did not finish, or one only an arm ran, adds nothing to either (US5-3)', () => {
    const off = [
      run('both', { promptTokens: 1_000, turns: 4 }),
      run('on-cut', { promptTokens: 7_000, turns: 40 }),
      run('off-cut', { completed: false, correct: false, promptTokens: 9_000, turns: 50 }),
      run('off-only', { promptTokens: 5_000, turns: 30 }),
    ]
    const on = [
      run('both', { promptTokens: 600, turns: 5, storedReads: 1 }),
      run('on-cut', { completed: false, correct: false, promptTokens: 8_000, turns: 60, storedReads: 9 }),
      run('off-cut', { promptTokens: 6_000, turns: 20, storedReads: 4 }),
      run('on-only', { promptTokens: 3_000, turns: 10, storedReads: 2 }),
    ]
    const report = summarise(off, on)
    expect(report.tasksCompared).toBe(1)
    expect(report.off).toMatchObject({ promptTokens: 1_000, turns: 4, correct: 1, storedReads: 0 })
    expect(report.on).toMatchObject({ promptTokens: 600, turns: 5, correct: 1, storedReads: 1 })
    expect(report.net.promptTokensSaved).toBe(400)
  })

  it('pairs the runs by task id, not by position (US5-3)', () => {
    const off = [run('a', { promptTokens: 1_000 }), run('b', { promptTokens: 2_000 })]
    const on = [run('b', { promptTokens: 1_500 }), run('a', { promptTokens: 400 })]
    const report = summarise(off, on)
    expect(report.tasksCompared).toBe(2)
    expect(report.off.promptTokens).toBe(3_000)
    expect(report.on.promptTokens).toBe(1_900)
  })

  it('states the net when it is a loss, with the figure, instead of leaving it out (US5-3)', () => {
    const report = summarise(arm({ promptTokens: 1_000 }), arm({ promptTokens: 1_200 }))
    expect(report.net.promptTokensSaved).toBe(-800)
    const text = textOf(report)
    expect(text).toMatch(/net/i)
    expect(text).toMatch(/loss/i)
    expect(text).toContain('800')
  })

  it('states the net when it is a saving, as a saving (US5-3)', () => {
    const report = summarise(arm({ promptTokens: 1_000 }), arm({ promptTokens: 900 }))
    expect(report.net.promptTokensSaved).toBe(400)
    const text = textOf(report)
    expect(text).toMatch(/net/i)
    expect(text).toMatch(/sav/i)
    expect(text).toContain('400')
  })

  it('says the module is not recommended for the workload when the module-on arm answers fewer tasks correctly, though it used fewer tokens (SC-007)', () => {
    const on = arm({ promptTokens: 500 })
    on[3] = run('d', { promptTokens: 500, correct: false })
    const report = summarise(arm(), on)
    expect(report.tasksCompared).toBe(4)
    expect(report.off.correct).toBe(4)
    expect(report.on.correct).toBe(3)
    expect(textOf(report)).toMatch(/not recommended/i)
  })

  it('does not say it when the module-on arm answers as many correctly, however many more tokens it used, nor when it answers more (SC-007)', () => {
    const loss = summarise(arm({ promptTokens: 1_000 }), arm({ promptTokens: 1_500 }))
    expect(loss.net.promptTokensSaved).toBeLessThan(0)
    expect(textOf(loss)).not.toMatch(/not recommended/i)

    const off = arm()
    off[0] = run('a', { correct: false })
    const better = summarise(off, arm())
    expect(better.on.correct).toBe(4)
    expect(better.off.correct).toBe(3)
    expect(textOf(better)).not.toMatch(/not recommended/i)
  })

  it('judges the correctness only over the tasks completed in both arms (SC-007)', () => {
    // The module-on arm got the task it alone completed wrong and the one the off arm cut short right: neither counts.
    const off = [run('a'), run('b'), run('c', { completed: false, correct: false })]
    const on = [run('a'), run('b'), run('c', { correct: true }), run('d', { correct: false })]
    const report = summarise(off, on)
    expect(report.tasksCompared).toBe(2)
    expect(report.off.correct).toBe(2)
    expect(report.on.correct).toBe(2)
    expect(textOf(report)).not.toMatch(/not recommended/i)
  })
})

describe('compare: the stage that spends money (US5-3, US5-4, FR-020)', () => {
  const task = (id: string): CompareTask => ({ id, prompt: `Task ${id}`, expect: `OK-${id}` })
  const tasks = ['t1', 't2', 't3', 't4', 't5', 't6'].map(task)

  interface Turn {
    /** Input tokens, cache writes, cache reads of the assistant message. */
    usage: [number, number, number]
    /** Stored originals the agent reads in this turn (not the last). */
    reads?: number
  }
  interface Spec { turns: Turn[]; answer?: string; subtype?: string; truncated?: boolean }
  const ok = (id: string) => `Done: OK-${id}.`
  const wrong = 'I could not tell.'

  /** A run's stream-json: a message per turn (the last one the answer), one call and its result per earlier turn, then the result entry. */
  function streamOf(spec: Spec): string {
    const message = (i: number, turn: Turn) => ({
      id: `msg_${i}`, role: 'assistant',
      usage: { input_tokens: turn.usage[0], cache_creation_input_tokens: turn.usage[1], cache_read_input_tokens: turn.usage[2], output_tokens: 10 },
    })
    const entries: unknown[] = [{ type: 'system', subtype: 'init', session_id: 'sess' }]
    spec.turns.forEach((turn, i) => {
      const last = i === spec.turns.length - 1
      if (last) {
        entries.push({ type: 'assistant', message: { ...message(i, turn), content: [{ type: 'text', text: spec.answer ?? '' }] } })
        return
      }
      const calls = [
        { type: 'tool_use', id: `toolu_${i}_cmd`, name: 'Bash', input: { command: 'npm test' } },
        ...Array.from({ length: turn.reads ?? 0 }, (_, j) => ({
          type: 'tool_use', id: `toolu_${i}_read${j}`, name: 'Read', input: { file_path: `/data/tool-results/${hex(i * 10 + j)}.txt` },
        })),
      ]
      entries.push({ type: 'assistant', message: { ...message(i, turn), content: [{ type: 'text', text: 'working' }] } })
      entries.push({ type: 'assistant', message: { ...message(i, turn), content: calls } })
      entries.push({ type: 'user', message: { role: 'user', content: calls.map(c => ({ type: 'tool_result', tool_use_id: c.id, content: 'output' })) } })
    })
    if (!spec.truncated) {
      entries.push({
        type: 'result', subtype: spec.subtype ?? 'success', is_error: false, num_turns: spec.turns.length,
        ...(spec.subtype === undefined ? { result: spec.answer ?? '' } : {}),
        usage: {
          input_tokens: sum(spec.turns.map(t => t.usage[0])),
          cache_creation_input_tokens: sum(spec.turns.map(t => t.usage[1])),
          cache_read_input_tokens: sum(spec.turns.map(t => t.usage[2])),
          output_tokens: 10 * spec.turns.length,
        },
      })
    }
    return entries.map(entry => JSON.stringify(entry)).join('\n')
  }

  // Six tasks. t3 is cut off in the module-on arm and t4 in the module-off arm,
  // so neither counts. In t2 the module-off arm answers wrong and in t5 the
  // module-on arm does, so each arm answers 3 of the 4 compared tasks correctly.
  const SPECS: Record<string, { off: Spec; on: Spec }> = {
    t1: {
      off: { turns: [{ usage: [100, 1_000, 0] }, { usage: [100, 200, 1_000] }], answer: ok('t1') },
      on: { turns: [{ usage: [100, 600, 0], reads: 1 }, { usage: [100, 100, 600] }], answer: ok('t1') },
    },
    t2: {
      off: { turns: [{ usage: [200, 2_000, 0] }, { usage: [100, 300, 2_000] }, { usage: [100, 100, 2_300] }], answer: wrong },
      on: { turns: [{ usage: [200, 1_200, 0], reads: 2 }, { usage: [100, 200, 1_200] }], answer: ok('t2') },
    },
    t3: {
      off: { turns: [{ usage: [10, 100, 0] }], answer: ok('t3') },
      on: { turns: [{ usage: [999, 99_999, 0] }], subtype: 'error_max_turns' },
    },
    t4: {
      off: { turns: [{ usage: [999, 99_999, 0] }], answer: ok('t4'), truncated: true },
      on: { turns: [{ usage: [10, 100, 0] }], answer: ok('t4') },
    },
    t5: {
      off: { turns: [{ usage: [300, 3_000, 0] }, { usage: [100, 500, 3_000] }], answer: ok('t5') },
      on: { turns: [{ usage: [300, 2_500, 0] }, { usage: [100, 400, 2_500] }], answer: wrong },
    },
    t6: {
      off: { turns: [{ usage: [10, 50, 0] }], answer: ok('t6') },
      on: { turns: [{ usage: [10, 40, 0] }], answer: ok('t6') },
    },
  }
  const runFromSpecs = async (t: CompareTask, arm: 'off' | 'on'): Promise<string> => streamOf(SPECS[t.id]![arm])

  it('reports the stage as not run, and never calls the runner, without approval (US5-4, FR-020)', async () => {
    const runner = vi.fn(runFromSpecs)
    const report = await compare({ approved: false, tasks, run: runner })
    expect(runner).not.toHaveBeenCalled()
    expect(report.ran).toBe(false)
    expect(report.tasksCompared).toBe(0)
    // Reported, not omitted.
    expect(textOf(report)).toMatch(/not run/i)
  })

  it('runs every task in both arms once, and one run at a time, when approved (US5-3)', async () => {
    const seen: Array<[string, string]> = []
    let inFlight = 0
    let overlapped = false
    const report = await compare({
      approved: true,
      tasks,
      run: async (t, arm) => {
        inFlight++
        overlapped ||= inFlight > 1
        seen.push([t.id, arm])
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight--
        return runFromSpecs(t, arm)
      },
    })
    expect(report.ran).toBe(true)
    expect(seen.map(([id, arm]) => `${id}/${arm}`).sort()).toEqual(tasks.flatMap(t => [`${t.id}/off`, `${t.id}/on`]).sort())
    // One proxy and one live switch serve both arms: two runs at once would mix them.
    expect(overlapped).toBe(false)
  })

  it('hands the runner the task as given and names the arm \'off\' or \'on\' (US5-3)', async () => {
    const runner = vi.fn(runFromSpecs)
    await compare({ approved: true, tasks: [tasks[0]!], run: runner })
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls.map(([t, arm]) => [t, arm]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([[tasks[0], 'off'], [tasks[0], 'on']])
  })

  it('reports each arm over the tasks completed in both arms only: per-arm prompt tokens, cache writes and reads, turns, correct answers and stored-original reads (US5-3, SC-007)', async () => {
    const report = await compare({ approved: true, tasks, run: runFromSpecs })
    // t1, t2, t5 and t6: t3 and t4 were cut off in one arm and are in neither.
    expect(report.tasksCompared).toBe(4)
    expect(report.off).toEqual({ promptTokens: 16_460, cacheWrites: 7_150, cacheReads: 8_300, turns: 8, correct: 3, storedReads: 0 })
    expect(report.on).toEqual({ promptTokens: 10_250, cacheWrites: 5_040, cacheReads: 4_300, turns: 7, correct: 3, storedReads: 3 })
    expect(report.net.promptTokensSaved).toBe(6_210)
    expect(textOf(report)).not.toMatch(/not recommended/i)
  })

  it('treats a run that fails to start as not completed, and goes on with the other tasks (US5-3)', async () => {
    const report = await compare({
      approved: true,
      tasks: [tasks[0]!, tasks[1]!, tasks[4]!, tasks[5]!],
      run: (t, arm) => (t.id === 't5' && arm === 'on' ? Promise.reject(new Error('claude did not start')) : runFromSpecs(t, arm)),
    })
    expect(report.ran).toBe(true)
    // t1, t2 and t6 only.
    expect(report.tasksCompared).toBe(3)
    expect(report.off.promptTokens).toBe(2_400 + 7_100 + 60)
    expect(report.on.promptTokens).toBe(1_500 + 2_900 + 50)
  })

  it('reads the recorded fixtures of a module-off and a module-on run end to end (US5-3)', async () => {
    const report = await compare({
      approved: true,
      tasks: [FAILING],
      run: async (_t, arm) => fixture(arm === 'off' ? 'compare-off.jsonl' : 'compare-on.jsonl'),
    })
    expect(report.tasksCompared).toBe(1)
    expect(report.off).toEqual({ promptTokens: 22_590, cacheWrites: 9_300, cacheReads: 13_000, turns: 3, correct: 1, storedReads: 0 })
    expect(report.on).toEqual({ promptTokens: 20_600, cacheWrites: 5_800, cacheReads: 14_500, turns: 4, correct: 1, storedReads: 2 })
    expect(report.net.promptTokensSaved).toBe(1_990)
  })

  it('states the net as a loss when the module-on arm used more prompt tokens, and says not recommended when it answered fewer tasks correctly (US5-3, SC-007)', async () => {
    // The module-on arm re-reads and answers worse: the worst workload for the module.
    const worse = async (t: CompareTask, arm: 'off' | 'on'): Promise<string> => streamOf(arm === 'off'
      ? { turns: [{ usage: [100, 1_000, 0] }], answer: ok(t.id) }
      : { turns: [{ usage: [100, 1_000, 0], reads: 1 }, { usage: [100, 400, 1_000] }], answer: t.id === 't1' ? wrong : ok(t.id) })
    const report = await compare({ approved: true, tasks: tasks.slice(0, 4), run: worse })
    expect(report.tasksCompared).toBe(4)
    expect(report.net.promptTokensSaved).toBe(4 * (1_100 - 2_600))
    expect(report.off.correct).toBe(4)
    expect(report.on.correct).toBe(3)
    expect(textOf(report)).toMatch(/loss/i)
    expect(textOf(report)).toMatch(/not recommended/i)
  })
})

// ---------------------------------------------------------------------------
// The billed harness's child (FR-020; automated security review, MEDIUM). The
// `claude -p` child ran unrestricted `Bash` (`--allowedTools Bash,Read,Grep,Glob`)
// with project settings loaded from whatever `--repo` it was pointed at
// (`--setting-sources project`). Nothing below spawns the agent: `claudeArgs`
// is the argument list `runClaude` hands to `spawn`, and `runApproved` is
// exercised only up to the point where it would create its scratch directory.
// ---------------------------------------------------------------------------

/** The tasks the billed run gives the agent. */
const compareTasks = (): CompareTask[] => JSON.parse(fs.readFileSync(new URL('./shunt/compare-tasks.json', import.meta.url), 'utf8')) as CompareTask[]
/** The command a task tells the agent to run: the first word of the prompt's fenced block. */
const commandOf = (task: CompareTask): string | undefined => /```\n(\S+)/.exec(task.prompt)?.[1]
/** The values after a flag, up to the next flag. */
const valuesOf = (args: string[], name: string): string[] => {
  const at = args.indexOf(name)
  if (at < 0) return []
  const values: string[] = []
  for (const arg of args.slice(at + 1)) {
    if (arg.startsWith('-')) break
    values.push(arg)
  }
  return values
}
/** The tools the child may use, however the flag's list is written (comma or space separated). */
const allowedTools = (args: string[]): string[] => valuesOf(args, '--allowedTools').flatMap(v => v.split(/[,\s]+/)).filter(v => v !== '')

describe('claudeArgs: what the billed child may do (FR-020, security review)', () => {
  const args = (): string[] => claudeArgs('/scratch/llm-fw-shunt-compare-x', 2)

  it('does not allow Bash unrestricted: no bare Bash, no wildcard Bash rule', () => {
    const tools = allowedTools(args())
    expect(tools).not.toContain('Bash')
    expect(tools.filter(t => /^Bash(\(\*?\))?$/.test(t))).toEqual([])
  })

  it('limits Bash to one prefix rule per command the compare tasks run: Bash(awk:*)', () => {
    // The commands come off the tasks file, so a task that needs another one fails here. Every task runs awk today; an empty
    // set would let a child with no shell at all pass.
    const tasks = compareTasks()
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.map(commandOf).every(c => c !== undefined)).toBe(true)
    const commands = [...new Set(tasks.map(commandOf))]
    expect(commands).toEqual(['awk'])
    const bash = allowedTools(args()).filter(t => t.startsWith('Bash'))
    expect(bash).toEqual(['Bash(awk:*)'])
    expect(bash.sort()).toEqual(commands.map(c => `Bash(${c}:*)`).sort())
  })

  it('keeps Read, Grep and Glob, and allows no tool that writes', () => {
    expect(allowedTools(args()).filter(t => !t.startsWith('Bash')).sort()).toEqual(['Glob', 'Grep', 'Read'])
  })

  it('keeps --setting-sources project: user settings on this machine deny native Read (lean-ctx), which would leave the child agent without a way to read the stored originals', () => {
    expect(valuesOf(args(), '--setting-sources')).toEqual(['project'])
  })

  it('keeps the rest of the child\'s configuration: strict MCP config, no saved session, the budget cap, the scratch folder', () => {
    expect(args()).toContain('-p')
    expect(valuesOf(args(), '--output-format')).toEqual(['stream-json'])
    expect(args()).toContain('--strict-mcp-config')
    expect(args()).toContain('--no-session-persistence')
    expect(valuesOf(args(), '--max-budget-usd')).toEqual(['2'])
    expect(valuesOf(args(), '--add-dir')).toEqual(['/scratch/llm-fw-shunt-compare-x'])
  })
})

describe('--repo may not carry project settings of its own (FR-020, security review)', () => {
  const made: string[] = []
  /** A throwaway repository with the given files, outside llm-fw. */
  const repoWith = (files: string[]): string => {
    const repo = fs.mkdtempSync(join(tmpdir(), 'shunt-compare-repo-'))
    made.push(repo)
    for (const file of files) {
      fs.mkdirSync(join(repo, file, '..'), { recursive: true })
      fs.writeFileSync(join(repo, file), '{}')
    }
    return repo
  }
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const SETTINGS = ['settings.json', 'settings.local.json']
  const nameOf = (file: string): RegExp => new RegExp(file.replace(/\./g, '\.'))

  it.each(SETTINGS)('checkRepoSettings throws, naming the file, for a repo with .claude/%s: --setting-sources project would load its hooks and permissions', file => {
    expect(() => checkRepoSettings(repoWith([`.claude/${file}`]))).toThrow(nameOf(file))
  })

  it('checkRepoSettings accepts a repo without a .claude folder, and one whose .claude holds neither settings file', () => {
    expect(() => checkRepoSettings(repoWith([]))).not.toThrow()
    expect(() => checkRepoSettings(repoWith(['CLAUDE.md', '.claude/commands/review.md']))).not.toThrow()
  })

  it.each(SETTINGS)('runApproved refuses a repo with .claude/%s before any scratch directory is created, and goes on to create one for a repo without', async file => {
    const flagged = repoWith([`.claude/${file}`])
    const clean = repoWith([])
    const argsFor = (repo: string): string[] => ['--approve-spend', '--repo', repo, '--worker-url', 'http://127.0.0.1:11434', '--worker-model', 'qwen2.5:3b']
    // The scratch directory is the first thing runApproved writes. Stopping there keeps this test from starting a proxy or an agent.
    const mkdtemp = vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw new Error('scratch directory created') })

    await expect(runApproved(argsFor(flagged), [FAILING])).rejects.toThrow(nameOf(file))
    expect(mkdtemp).not.toHaveBeenCalled()

    // The control: the same call for a repo without settings gets past the check and reaches the scratch directory.
    await expect(runApproved(argsFor(clean), [FAILING])).rejects.toThrow('scratch directory created')
    expect(mkdtemp).toHaveBeenCalledTimes(1)
  })
})
