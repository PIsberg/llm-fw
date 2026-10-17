/**
 * Comparison stage of the tool result shunt (specs/001-tool-result-shunt: US5,
 * FR-020, SC-007): the same tasks run through the real agent twice, once with
 * the module off and once on, and the two runs set side by side.
 *
 * STUB. The signatures are those of tasks.md T026; every body throws until T026
 * implements it. test/eval/shuntCompare.test.ts is the executable spec. T026
 * also adds `main()` and the `eval:shunt:compare` script.
 *
 * `CompareReport` and `ArmTotals` are left open by T026. The fields declared
 * here are the ones the tests read, and they are the contract:
 *
 * - `ran`: false when the spend was not approved (US5-4);
 * - `tasksCompared`: tasks completed in both arms, the only ones any figure counts;
 * - `off` and `on`: the arm's totals over those tasks;
 * - `net.promptTokensSaved`: `off.promptTokens - on.promptTokens`, negative for a loss;
 * - `lines`: the report as sentences, one per entry, for the guide.
 */

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
  /** `tool_use` calls whose input names a stored original (`/[0-9a-f]{64}\.txt/`). */
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

export interface CompareReport {
  ran: boolean
  tasksCompared: number
  off: ArmTotals
  on: ArmTotals
  net: { promptTokensSaved: number }
  lines: string[]
}

const notImplemented = (name: string): never => {
  throw new Error(`not implemented: ${name} (tasks.md T026)`)
}

/** Read one run's stream-json (`claude -p --output-format stream-json --verbose`, one JSON object per line). */
export function parseRun(_streamJson: string, _task: CompareTask): ArmRun {
  return notImplemented('parseRun')
}

/** Set the two arms side by side, over the tasks completed in both. */
export function summarise(_off: ArmRun[], _on: ArmRun[]): CompareReport {
  return notImplemented('summarise')
}

/**
 * Run every task in both arms through `run` and summarise. Without `approved`
 * nothing is run and the report says the stage was not run (FR-020, US5-4).
 */
export async function compare(_opts: {
  approved: boolean
  tasks: CompareTask[]
  run: (task: CompareTask, arm: 'off' | 'on') => Promise<string>
}): Promise<CompareReport> {
  return notImplemented('compare')
}
