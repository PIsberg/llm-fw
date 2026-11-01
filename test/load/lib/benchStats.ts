/**
 * Pure helpers for the load benchmark (test/load/benchmark.ts): latency
 * summaries, CPU arithmetic, and the request bodies each workload sends.
 *
 * Every body carries text the firewall has not seen before. The pipeline caches
 * a clean item's verdict by its text, so replaying a fixed prompt list would
 * measure the cache after the first pass rather than detection.
 */
import { percentile } from './harness.js'

export interface LatencySummary {
  count: number
  meanMs: number
  p50Ms: number
  p90Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export function summarizeLatencies(latencies: readonly number[]): LatencySummary {
  if (latencies.length === 0) return { count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 }
  const sorted = [...latencies].sort((a, b) => a - b)
  const sum = sorted.reduce((s, v) => s + v, 0)
  return {
    count: sorted.length,
    meanMs: round2(sum / sorted.length),
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1]!,
  }
}

/** A point on the firewall process's clock: wall time and cumulative CPU. */
export interface CpuPoint { wallMs: number; cpuMicros: number }

/** CPU used between two points as a percentage of one core (can exceed 100). */
export function cpuPctBetween(a: CpuPoint, b: CpuPoint): number {
  const wall = b.wallMs - a.wallMs
  if (wall <= 0) return 0
  return round2(((b.cpuMicros - a.cpuMicros) / 1000 / wall) * 100)
}

export function countStatuses(statuses: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of statuses) out[String(s)] = (out[String(s)] ?? 0) + 1
  return out
}

/** Parse `LOAD_BENCH_CONCURRENCY`-style lists: "1,2,4". */
export function parseLevels(raw: string | undefined, fallback: readonly number[]): number[] {
  if (raw === undefined || raw.trim() === '') return [...fallback]
  return raw.split(',').map(part => {
    const n = Number(part.trim())
    if (!Number.isInteger(n) || n < 1) throw new Error(`not a positive integer: "${part.trim()}"`)
    return n
  })
}

const MODEL = 'claude-sonnet-4-5'

/** One short benign prompt, made unique by a ticket number. */
export function chatBody(prompts: readonly string[], seq: number): string {
  const prompt = prompts[seq % prompts.length]!
  return JSON.stringify({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: `${prompt} This is for ticket ${10_000 + seq}.` }],
  })
}

/** One attack prompt as the newest user message. Blocks are never cached. */
export function attackBody(attacks: readonly { prompt: string }[], seq: number): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: attacks[seq % attacks.length]!.prompt }],
  })
}

const NOUNS = ['order', 'invoice', 'customer', 'shipment', 'account', 'report', 'session', 'ticket', 'product', 'payment']
const VERBS = ['compute', 'validate', 'format', 'merge', 'filter', 'collect', 'resolve', 'normalize']

/** A deterministic, benign TypeScript module of roughly `bytes` bytes. */
function codeFile(seed: number, bytes: number): string {
  const out: string[] = [`// src/services/module${seed}.ts`, `import { Item } from '../types.js'`, '']
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const noun = NOUNS[(seed + i) % NOUNS.length]!
    const verb = VERBS[(seed * 3 + i) % VERBS.length]!
    const fn = [
      `/** ${verb[0]!.toUpperCase()}${verb.slice(1)} the ${noun} totals for one batch. */`,
      `export function ${verb}${noun[0]!.toUpperCase()}${noun.slice(1)}${seed}_${i}(items: Item[]): number {`,
      '  let total = 0',
      '  for (const item of items) {',
      `    if (item.kind !== '${noun}') continue`,
      `    total += item.price * item.quantity + ${(seed * 7 + i) % 13}`,
      '  }',
      '  return Math.round(total * 100) / 100',
      '}',
      '',
    ].join('\n')
    out.push(fn)
    size += fn.length
  }
  return out.join('\n')
}

const SYSTEM_TEXT = [
  'You are a coding assistant working in a TypeScript repository.',
  'Read files before editing them, keep changes small, and run the tests after each change.',
  'Prefer the existing helpers in src/services over new ones, and follow the style of the surrounding code.',
  'When a test fails, read its output before changing anything.',
].join(' ')

const TOOLS = [
  { name: 'Read', description: 'Read a file from the repository.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'Edit', description: 'Replace a string in a file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'Bash', description: 'Run a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
]

const TOOL_RESULT_BYTES = 3 * 1024
const historyCache = new Map<string, unknown[]>()

/** The resent part of the conversation: identical for every request of a run. */
function agentHistory(prompts: readonly string[], targetKb: number): unknown[] {
  const key = `${targetKb}\0${prompts.join('\0')}`
  const hit = historyCache.get(key)
  if (hit) return hit
  const messages: unknown[] = [{ role: 'user', content: prompts[0] ?? 'Help me refactor the services.' }]
  const budget = targetKb * 1024 - TOOL_RESULT_BYTES - 2 * 1024
  for (let turn = 0; JSON.stringify(messages).length < budget; turn++) {
    const id = `toolu_hist_${turn}`
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `src/services/module${turn}.ts` } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: codeFile(turn, TOOL_RESULT_BYTES) }] })
  }
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_latest', name: 'Read', input: { file_path: 'src/services/latest.ts' } }] })
  historyCache.set(key, messages)
  return messages
}

/**
 * A coding-agent request of about `targetKb`: system prompt, tool definitions
 * and a resent history of file reads, then one new tool result. That is the
 * shape Claude Code sends every turn: the history hits the item cache after
 * the first request, the newest tool result is scanned cold.
 */
export function agentBody(prompts: readonly string[], seq: number, targetKb: number): string {
  const latest = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_latest', content: codeFile(1000 + seq, TOOL_RESULT_BYTES) }] }
  return JSON.stringify({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_TEXT }],
    tools: TOOLS,
    messages: [...agentHistory(prompts, targetKb), latest],
  })
}
