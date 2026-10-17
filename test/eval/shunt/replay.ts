/**
 * Replay stage of the tool result shunt (specs/001-tool-result-shunt: US5,
 * FR-019, FR-020, SC-002, SC-006; plan Design 9 and D6).
 *
 * Recorded Claude Code sessions in, the figures of US5-1 out. For every tool
 * result the module would act on it runs the module's own pieces: `eligibility`
 * (tool, size, range arguments), the detection and DLP screen the proxy runs
 * first, then `condense` against a local worker and `StoredOriginals`. It
 * counts only what the module would condense, so a result detection flagged or
 * could not vouch for is left out of every token figure and counted in
 * `excluded`. Main-model tokens and worker tokens are reported apart.
 *
 * Usage:
 *   node --import tsx/esm test/eval/shunt/replay.ts --worker-url http://127.0.0.1:11434 \
 *     --worker-model qwen2.5:3b [--sessions ~/.claude/projects] [--max-sessions 200] \
 *     [--wait-ms 15000] [--out report.json]
 *
 * Set LLM_FW_MODEL_DIR to the detection models' cache, or the models download
 * into the scratch directory. Originals the replay stores go under a scratch
 * LLM_FW_DIR that `main` makes and removes, never under ~/.llm-fw (FR-020).
 */
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Config, ToolResultShuntConfig } from '../../../src/types.js'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'
import { getLlmFwDir } from '../../../src/config/paths.js'
import { Pipeline } from '../../../src/detection/pipeline.js'
import { DlpScanner } from '../../../src/detection/dlp/scanner.js'
import { Screening } from '../../../src/modules/screening.js'
import { collectTextSlots } from '../../../src/modules/payload.js'
import { eligibility } from '../../../src/modules/builtin/toolResultShunt.js'
import { condense, isLocalWorkerUrl } from '../../../src/modules/shuntWorker.js'
import { StoredOriginals } from '../../../src/modules/shuntStore.js'

/** One tool result of a recorded session, paired with the call that made it. */
export interface ReplayItem {
  name: string
  input: unknown
  text: string
  /**
   * Distinct assistant `message.id`s after the result's line and before the
   * next `"subtype":"compact_boundary"` entry of the same file, less the first,
   * which reads the result as new input (plan Design 9). Never negative.
   */
  rereads: number
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The content blocks of a transcript entry's message; a string content has none. */
function blocksOf(entry: Obj): Obj[] {
  const message = entry['message']
  if (!isObj(message) || !Array.isArray(message['content'])) return []
  return message['content'].filter(isObj)
}

/** The text of a `tool_result` block: a string, or its text parts joined by a newline. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is Obj => isObj(part) && part['type'] === 'text' && typeof part['text'] === 'string')
    .map(part => part['text'] as string)
    .join('\n')
}

/** Pairs each `tool_result` of a Claude Code transcript with the `tool_use` of the same id. */
export function pairToolResults(jsonl: string): ReplayItem[] {
  const entries: Obj[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry: unknown = JSON.parse(line)
      if (isObj(entry)) entries.push(entry)
    } catch {
      // A torn line (a transcript cut while Claude Code was writing) is not an entry.
    }
  }

  const isAssistant = (entry: Obj): boolean => entry['type'] === 'assistant'
  const calls = new Map<string, { name: string; input: unknown }>()
  for (const entry of entries) {
    if (!isAssistant(entry)) continue
    for (const block of blocksOf(entry)) {
      if (block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
        calls.set(block['id'], { name: block['name'], input: block['input'] })
      }
    }
  }

  // Backwards, so the distinct assistant message ids after each entry are
  // known without a rescan; a compaction drops everything before it.
  const rereads = new Array<number>(entries.length).fill(0)
  const later = new Set<string>()
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry['subtype'] === 'compact_boundary') {
      later.clear()
      continue
    }
    rereads[i] = Math.max(0, later.size - 1)
    const message = entry['message']
    if (isAssistant(entry) && isObj(message) && typeof message['id'] === 'string') later.add(message['id'])
  }

  const items: ReplayItem[] = []
  entries.forEach((entry, i) => {
    if (entry['type'] !== 'user') return
    for (const block of blocksOf(entry)) {
      if (block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue
      const call = calls.get(block['tool_use_id'])
      if (call) items.push({ name: call.name, input: call.input, text: resultText(block['content']), rereads: rereads[i]! })
    }
  })
  return items
}

// The key facts of plan D6: lines a test runner or a shell prints about a
// failure, an error, the final status or a summary count. A format none of
// these knows is not measured.
const FACT_LINES: readonly RegExp[] = [
  // A failing test or suite: vitest and jest `FAIL path > name`, pytest `FAILED path::name`, go `--- FAIL: Name`, jest `● suite › name`, `✕ name`.
  /^\s*(?:FAIL|FAILED|ERROR)\b\s+\S/,
  /^\s*--- FAIL:\s*\S/,
  /^\s*[●✗✕×]\s+\S/,
  // cargo `test name ... FAILED`.
  /^\s*test\s.+\s\.\.\.\s+FAILED\b/,
  // An error line: `AssertionError: ...`, `Error: ...`, `error[E0308]: ...`, `error: ...`, a Python `E   assert ...`, a Go panic, a TypeScript `error TS2345`.
  /^\s*(?:[\w.]*(?:Error|Exception)\b|error\b|fatal\b|panic\b)\s*[:[(]/i,
  /^E\s{2,}\S/,
  /\berror TS\d+:/,
  // The final status: `npm ERR! ...`, `exit code 1`, `exited with code 1`, `exit status 1`.
  /^\s*npm (?:ERR!|error)\s+\S/,
  /\bexit(?:ed)?\s+(?:with\s+)?(?:status|code)\s*[:=]?\s*-?\d+/i,
  // Summary counts: runner summary lines, and any `N failed` / `N passed` / `N failing` / `N passing`.
  /^\s*(?:Test Files|Tests?|Test Suites)\s*:?\s+\d/,
  /\b\d+\s+(?:failed|passed|failing|passing)\b/i,
]

/** The longest fact kept, in characters; a longer line is cut, and a cut line is still verbatim. */
const MAX_FACT = 300

/** The key facts of D6 that a rule-based extractor finds in an original tool result: trimmed lines, each as the original writes it, in order, once. */
export function extractKeyFacts(original: string): string[] {
  const facts = new Set<string>()
  for (const raw of original.split(/\r?\n/)) {
    const line = raw.trim()
    if (line !== '' && FACT_LINES.some(pattern => pattern.test(line))) facts.add(line.slice(0, MAX_FACT).trimEnd())
  }
  return [...facts]
}

export type ScreenVerdict = 'clean' | 'flagged' | 'unscanned'

const REQUEST_PATH = '/v1/messages'

/**
 * Detection and DLP over one result, as the proxy runs them before the module acts (FR-012).
 * Each result goes in an Anthropic Messages body (an assistant `tool_use`, a user `tool_result`)
 * through one `Pipeline` and one `DlpScanner` shared by all calls, and what they make of it is
 * noted into a `Screening` as `src/proxy/proxy.ts` notes it. The pipeline loads its models on
 * the first call.
 */
export function detectionScreen(config: Config): (item: ReplayItem) => Promise<ScreenVerdict> {
  const pipeline = new Pipeline(config)
  const dlp = new DlpScanner(config.dlp)
  let ready: Promise<void> | undefined

  return async item => {
    ready ??= pipeline.init()
    await ready

    let body = JSON.stringify({
      model: 'claude-replay',
      max_tokens: 1,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_replay', name: item.name, input: item.input ?? {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_replay', content: item.text }] },
      ],
    })
    const screening = new Screening()

    if (config.dlp.enabled) {
      const findings = dlp.scan(body)
      if (findings.length > 0) {
        screening.noteDlp(body, findings)
        // Block mode refuses the request; redact mode scans the redacted body, as the proxy does.
        if (config.dlp.mode === 'block') return 'flagged'
        if (config.dlp.mode === 'redact') body = dlp.redact(body, findings)
      }
    }

    try {
      const result = await pipeline.run(REQUEST_PATH, body, {
        target: 'api.anthropic.com',
        method: 'POST',
        path: REQUEST_PATH,
        onItemScanned: text => screening.noteItemScanned(text),
        onItemFlag: text => screening.noteItemFlag(text),
      })
      if (result.enforced === false) screening.cutShort()
      if (result.action === 'block') return 'flagged'
    } catch {
      // A pipeline that failed cannot vouch for anything it did not note.
      screening.incomplete()
    }

    const slots = collectTextSlots(JSON.parse(body))
    const screened = screening.flaggedSlots(slots)
    const results = slots.flatMap((slot, index) => (slot.kind === 'tool_result' ? [index] : []))
    if (results.some(index => screened.flagged.has(index))) return 'flagged'
    if (screened.all || results.some(index => screened.unreached.has(index))) return 'unscanned'
    return 'clean'
  }
}

/** The figures of US5-1, computed per plan Design 9. Token counts come from `opts.countTokens` on LF-normalised text. */
export interface ReplayReport {
  /** A sentence saying that only results the module would condense were counted. */
  scope: string
  /** `opts.tokenizer`. */
  tokenizer: string
  /** `opts.worker.model`. */
  workerModel: string
  /** `opts.sampleSessions`. */
  sampleSessions: number
  date: string
  /** `opts.includeFileReads`. */
  fileReadsIncluded: boolean

  /** Tool results in `items`, whatever their tool or size. */
  seen: number
  /** Results that pass `eligibility` and that `screen` calls `'clean'`: the ones the worker is asked about. */
  eligible: number
  /** Eligible results the worker condensed and whose original is stored. */
  condensed: number
  /** Eligible results with a `worker-failed` outcome, a timeout included. */
  workerFailed: number
  /** Eligible results whose worker answer the citation or size check rejected. */
  rejected: number
  /** Eligible results the worker condensed but whose original could not be stored, so the module forwards them whole. */
  storeFailed: number
  /** Results that pass `eligibility` but that `screen` calls `'flagged'` or `'unscanned'`. Never sent to the worker. */
  excluded: { flagged: number; unscanned: number }

  /** Sum of `countTokens(original)` over the eligible results. */
  originalTokens: number
  /** Sum of `countTokens(condensed result as forwarded)` over the condensed results. */
  condensedTokens: number
  /** `1 - condensedTokens / (original tokens of the condensed results)`, a fraction; 0 with nothing condensed. */
  reduction: number
  /** `tokensAvoided / countTokens of every seen result`, a fraction. */
  shareSaved: number

  /** Sum over condensed results of `countTokens(original) - countTokens(condensed result as forwarded)`. */
  tokensAvoided: number
  /** Sum of that difference times `(1.25 + 0.1 * rereads)`. */
  billWeighted: number
  /** `tokensIn` of every answered worker call (rejected ones included) plus `read` of a `partial-input` failure. */
  workerIn: number
  /** `tokensOut` of every answered worker call, rejected ones included. */
  workerOut: number
  /** `tokensAvoided - (workerIn + workerOut)`. */
  netTokensAvoided: number
  /** `billWeighted - (workerIn + workerOut)`. */
  netBillWeighted: number

  /** Condensed results whose original has at least one key fact (`extractKeyFacts`). */
  labelledSubset: number
  /** Key facts that appear in the condensed result, over the labelled subset; null when it is empty. */
  keyFactRetention: number | null
  /** Says so when the labelled subset is under the 50 SC-002 asks for (D6); null otherwise. */
  retentionCaveat: string | null
}

export interface ReplayOptions {
  worker: { url: string; model: string }
  countTokens: (text: string) => number
  includeFileReads: boolean
  screen: (item: ReplayItem) => Promise<ScreenVerdict>
  /** Wait limit per worker call, ms; 15,000 (the live limit of FR-008) when absent. */
  waitMs?: number
  /** Named in the report; 'unnamed' when absent. */
  tokenizer?: string
  /** Sessions the items came from, for the report; 0 when absent. */
  sampleSessions?: number
}

const LF = (text: string): string => text.replace(/\r\n/g, '\n')
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** SC-002 asks for a labelled subset of at least this many results. */
const MIN_LABELLED = 50

export async function replay(items: ReplayItem[], opts: ReplayOptions): Promise<ReplayReport> {
  const waitMs = opts.waitMs ?? 15_000
  const defaults = DEFAULT_CONFIG.modules!.toolResultShunt!
  // The shipped tool list holds no file-reading tool; the second report adds Claude Code's.
  const cfg: ToolResultShuntConfig = { ...defaults, tools: opts.includeFileReads ? [...defaults.tools, 'Read'] : defaults.tools }
  // A live run is capped and swept; a replay compresses weeks into minutes, and a full folder would change what it measures.
  const store = new StoredOriginals(() => Number.MAX_SAFE_INTEGER)
  const count = (text: string): number => opts.countTokens(LF(text))

  let seenTokens = 0
  let eligible = 0
  let condensed = 0
  let workerFailed = 0
  let rejected = 0
  let storeFailed = 0
  const excluded = { flagged: 0, unscanned: 0 }
  let originalTokens = 0
  let condensedOriginal = 0
  let condensedTokens = 0
  let billWeighted = 0
  let workerIn = 0
  let workerOut = 0
  let labelledSubset = 0
  let factsFound = 0
  let factsTotal = 0

  for (const item of items) {
    const original = count(item.text)
    seenTokens += original
    if (eligibility(item.name, item.input, item.text, cfg, '127.0.0.1') !== null) continue

    // Detection first, as the proxy runs it: nothing a scan flagged or did not reach goes to the worker.
    const verdict = await opts.screen(item)
    if (verdict !== 'clean') {
      excluded[verdict]++
      continue
    }
    eligible++
    originalTokens += original

    const outcome = await condense(item.text, store.pathFor(item.text), opts.worker, Date.now() + waitMs)
    if ('text' in outcome) {
      workerIn += outcome.tokensIn
      workerOut += outcome.tokensOut
      // The module forwards a result whole when its original is not on disk.
      if (await store.write(item.text) !== 'stored') {
        storeFailed++
        continue
      }
      condensed++
      const forwarded = count(outcome.text)
      condensedOriginal += original
      condensedTokens += forwarded
      billWeighted += (original - forwarded) * (1.25 + 0.1 * item.rereads)

      const facts = extractKeyFacts(item.text)
      if (facts.length > 0) {
        const kept = squash(outcome.text)
        labelledSubset++
        factsTotal += facts.length
        factsFound += facts.filter(fact => kept.includes(squash(fact))).length
      }
    } else if (outcome.reason === 'rejected') {
      rejected++
      workerIn += outcome.tokensIn
      workerOut += outcome.tokensOut
    } else {
      workerFailed++
      if (outcome.problem === 'partial-input') workerIn += outcome.read ?? 0
    }
  }

  const tokensAvoided = condensedOriginal - condensedTokens
  const workerTokens = workerIn + workerOut
  return {
    scope: 'Only results the module would condense are counted: eligible by tool, size and arguments, and clean under detection and DLP. Flagged and unscanned results are left out of every token figure and counted in excluded.',
    tokenizer: opts.tokenizer ?? 'unnamed',
    workerModel: opts.worker.model,
    sampleSessions: opts.sampleSessions ?? 0,
    date: new Date().toISOString().slice(0, 10),
    fileReadsIncluded: opts.includeFileReads,
    seen: items.length,
    eligible,
    condensed,
    workerFailed,
    rejected,
    storeFailed,
    excluded,
    originalTokens,
    condensedTokens,
    reduction: condensedOriginal > 0 ? 1 - condensedTokens / condensedOriginal : 0,
    shareSaved: seenTokens > 0 ? tokensAvoided / seenTokens : 0,
    tokensAvoided,
    billWeighted,
    workerIn,
    workerOut,
    netTokensAvoided: tokensAvoided - workerTokens,
    netBillWeighted: billWeighted - workerTokens,
    labelledSubset,
    keyFactRetention: factsTotal > 0 ? factsFound / factsTotal : null,
    retentionCaveat: labelledSubset < MIN_LABELLED
      ? `The labelled subset holds ${labelledSubset} results, under the ${MIN_LABELLED} SC-002 asks for; the retention figure is not yet a measure of it. Formats the extractor does not know are not measured.`
      : null,
  }
}

const TOKENIZER = 'Xenova/gpt-4o'

/** The value after `--name`, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function integer(args: string[], name: string, fallback: number): number {
  const value = flag(args, name)
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} needs a whole number of at least 1, got ${value}`)
  return n
}

/** The transcripts under `root`, in sorted path order so two runs take the same sessions. */
function sessionFiles(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.jsonl'))
    .map(name => join(root, name))
    .sort()
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const workerUrl = flag(args, '--worker-url')
  const workerModel = flag(args, '--worker-model')
  if (!workerUrl || !workerModel) throw new Error('--worker-url and --worker-model are required')
  if (!isLocalWorkerUrl(workerUrl)) throw new Error('--worker-url must name this machine (http or https to localhost, 127.x.x.x or ::1)')
  const root = resolve(flag(args, '--sessions') ?? join(homedir(), '.claude', 'projects'))
  const maxSessions = integer(args, '--max-sessions', 200)
  const waitMs = integer(args, '--wait-ms', 15_000)
  const out = flag(args, '--out')

  // First, before anything that writes: whatever the replay stores goes here, never under the operator's ~/.llm-fw (FR-020).
  const scratch = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shunt-replay-'))
  process.env.LLM_FW_DIR = scratch
  try {
    const files = sessionFiles(root).slice(0, maxSessions)
    const items = files.flatMap(file => pairToolResults(fs.readFileSync(file, 'utf8')))
    process.stderr.write(`${files.length} sessions, ${items.length} tool results\n`)

    const { AutoTokenizer, env } = await import('@huggingface/transformers')
    env.cacheDir = process.env['LLM_FW_MODEL_DIR'] || join(getLlmFwDir(), 'models')
    const tokenizer = await AutoTokenizer.from_pretrained(TOKENIZER)
    const countTokens = (text: string): number => tokenizer.encode(text).length

    // The shipped defaults, never `loadConfig`: that reads the operator's own files (FR-020).
    const screen = detectionScreen({ ...DEFAULT_CONFIG })
    const shared = { worker: { url: workerUrl, model: workerModel }, countTokens, screen, waitMs, tokenizer: TOKENIZER, sampleSessions: files.length }
    const fileReadsExcluded = await replay(items, { ...shared, includeFileReads: false })
    const fileReadsIncluded = await replay(items, { ...shared, includeFileReads: true })

    const json = JSON.stringify({ fileReadsExcluded, fileReadsIncluded }, null, 2)
    if (out) fs.writeFileSync(resolve(out), `${json}\n`, 'utf8')
    else process.stdout.write(`${json}\n`)
    for (const report of [fileReadsExcluded, fileReadsIncluded]) {
      process.stderr.write(`file reads ${report.fileReadsIncluded ? 'included' : 'excluded'}: ${report.condensed} of ${report.eligible} eligible condensed, `
        + `${report.tokensAvoided} tokens avoided (${report.netTokensAvoided} net of the worker), labelled subset ${report.labelledSubset}\n`)
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1) })
}
