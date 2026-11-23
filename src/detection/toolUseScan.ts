// Outbound tool-call argument exfiltration guard — Task C1.
//
// A model that emits a tool_use/tool_call/functionCall can leak sensitive data
// through the ARGUMENTS it hands to the tool — a secret pasted into a
// file-write argument, or an attacker-controlled exfil URL passed to a fetch/
// webhook tool (the classic InjecAgent-style "read the secret, then call
// send_data(url, secret)" chain). The request-side DLP + URL checks never see
// this: they scan what the USER sent, not what the model decided to hand a
// tool. This module extracts every tool call the model's response carries —
// buffered JSON and flushed SSE text alike — and reuses the EXISTING DLP
// pattern engine (src/detection/dlp) and UrlClassifier (src/detection/
// urlHeuristic) verbatim over each call's serialized arguments. No new
// secret/URL patterns are defined here.
//
// Extraction for a BUFFERED JSON response simply delegates to the resolved
// PayloadParser's own `extractToolUses` (already implements Anthropic
// tool_use, OpenAI tool_calls / Responses-API function_call, Gemini
// functionCall, Bedrock toolUse — see parsers.ts) — no duplicate parsing.
//
// Extraction for FLUSHED SSE text has no equivalent single entry point: a
// streamed tool call's arguments arrive FRAGMENTED across several `data:`
// events (Anthropic content_block_start/content_block_delta/content_block_stop
// with input_json_delta chunks; OpenAI choices[].delta.tool_calls[] fragments
// keyed by call index). This module reconstructs each call from the
// accumulated text by walking the same event shapes the SSE tool gates in
// detection/mcp/responseGate.ts already parse for blocking — but to collect
// every call (name + args) rather than to decide block/pass. Gemini's
// streamed functionCall arrives whole in a single event (no fragmentation), so
// it needs no accumulator.

import { detectMemoryPoisoning, type MemoryPoisoningFinding } from './memoryPoisoning.js'
import type { PayloadParser, DlpFinding } from '../types.js'
import { RESPONSES_ARGUMENT_DELTAS, responsesToolCall } from './parsers.js'
import type { DlpScanner } from './dlp/scanner.js'

export interface ScannedToolCall {
  toolName: string
  args: unknown
}

/** Extract tool calls from a buffered (non-streaming) JSON response body. Delegates entirely to the resolved provider parser — see parsers.ts extractToolUses. */
export function extractToolCallsFromJson(body: string, parser: PayloadParser): ScannedToolCall[] {
  try {
    return parser.extractToolUses(body)
  } catch {
    return []
  }
}

interface AnthropicAccum { name: string; json: string; input: unknown }
interface OpenAiAccum { name: string; args: string }
interface ResponsesAccum { name: string; args: string; custom: boolean }

/**
 * Extract tool calls from accumulated FLUSHED SSE response text. Auto-detects
 * the event shape per `data:` payload (rather than trusting the provider the
 * request path resolved to) since each event already carries its own
 * discriminator (`type`, `choices`, `candidates`) and this keeps the function
 * usable directly against raw accumulated text with no parser dependency —
 * same style as scanResponseExfil / detectHarmfulCompliance.
 */
export function extractToolCallsFromSse(sseText: string): ScannedToolCall[] {
  if (!sseText) return []
  // Cohere v1 streams newline-delimited JSON, not SSE (#881); the proxy hands
  // it here as a line stream, and read as SSE it held no event (#916).
  if (/^\s*\{/.test(sseText)) return extractCohereNdjsonCalls(sseText)
  const out: ScannedToolCall[] = []
  const cohereByIndex = new Map<number, OpenAiAccum>()
  const anthropicByIndex = new Map<number, AnthropicAccum>()
  const openAiByIndex = new Map<number, OpenAiAccum>()
  const responsesByIndex = new Map<number, ResponsesAccum>()

  // Events end at a blank line in LF or CRLF (#859: CRLF yielded no event).
  for (const raw of sseText.split(/\r?\n\r?\n/)) {
    if (!raw.trim()) continue
    const payload = parseSseEventData(raw)
    if (payload === null || payload === '[DONE]') continue

    let data: Record<string, unknown>
    try { data = JSON.parse(payload) as Record<string, unknown> } catch { continue }
    // Google's Cloud Code API (Antigravity, Gemini CLI) wraps each Gemini
    // event in `response` (#594).
    const wrapped = data.response as Record<string, unknown> | undefined
    if (wrapped && typeof wrapped === 'object' && Array.isArray(wrapped.candidates)) data = wrapped

    const type = typeof data.type === 'string' ? data.type : undefined
    const index = typeof data.index === 'number' ? data.index : undefined

    // OpenAI Responses API (#859): a call is an output item. `added` names
    // it, argument or input deltas follow, and `done` carries it whole;
    // `response.completed` repeats every item, so it is not read again.
    if (type?.startsWith('response.')) {
      const at = typeof data.output_index === 'number' ? data.output_index : 0
      if (type === 'response.output_item.added') {
        const item = data.item as Record<string, unknown> | undefined
        const call = responsesToolCall(item)
        if (call) responsesByIndex.set(at, { name: call.toolName, args: '', custom: item?.type === 'custom_tool_call' })
      } else if (RESPONSES_ARGUMENT_DELTAS.has(type) && typeof data.delta === 'string') {
        const entry = responsesByIndex.get(at)
        if (entry) entry.args += data.delta
      } else if (type === 'response.output_item.done') {
        const call = responsesToolCall(data.item)
        if (call) { responsesByIndex.delete(at); out.push(call) }
      }
      continue
    }

    // Cohere v2 (#916): tool-call-start names the call, tool-call-delta
    // fragments carry its arguments, tool-call-end closes it, all by index.
    if (type === 'tool-call-start' || type === 'tool-call-delta' || type === 'tool-call-end') {
      const at = index ?? 0
      if (type === 'tool-call-end') {
        const entry = cohereByIndex.get(at)
        cohereByIndex.delete(at)
        if (entry?.name) out.push({ toolName: entry.name, args: parseJsonArgs(entry.args) })
      } else {
        const part = cohereStreamPart(data)
        const entry = cohereByIndex.get(at) ?? { name: '', args: '' }
        if (part.name) entry.name = part.name
        entry.args += part.args
        cohereByIndex.set(at, entry)
      }
      continue
    }

    // Anthropic: content_block_start (a tool block, name) -> content_block_delta
    // (input_json_delta, partial_json fragments) -> content_block_stop. Server
    // and MCP tool blocks too (#916), and an input that arrived whole in the
    // start event is the arguments when no fragment follows.
    if (type === 'content_block_start' && index !== undefined) {
      const block = data.content_block as Record<string, unknown> | undefined
      if (block && ANTHROPIC_TOOL_BLOCKS.has(block.type as string) && typeof block.name === 'string') {
        anthropicByIndex.set(index, { name: block.name, json: '', input: block.input })
      }
      continue
    }
    if (type === 'content_block_delta' && index !== undefined && anthropicByIndex.has(index)) {
      const delta = data.delta as Record<string, unknown> | undefined
      if (delta && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        anthropicByIndex.get(index)!.json += delta.partial_json
      }
      continue
    }
    if (type === 'content_block_stop' && index !== undefined && anthropicByIndex.has(index)) {
      const entry = anthropicByIndex.get(index)!
      anthropicByIndex.delete(index)
      out.push({ toolName: entry.name, args: anthropicArgs(entry) })
      continue
    }

    // Gemini streamGenerateContent (alt=sse): each event already carries a
    // COMPLETE functionCall — identical shape to the buffered response, so no
    // accumulation state is needed.
    if (Array.isArray(data.candidates)) {
      for (const cand of data.candidates as Array<Record<string, unknown>>) {
        const content = cand?.content as Record<string, unknown> | undefined
        const parts = content?.parts
        if (!Array.isArray(parts)) continue
        for (const part of parts as Array<Record<string, unknown>>) {
          const fc = part?.functionCall as Record<string, unknown> | undefined
          if (fc && typeof fc.name === 'string') out.push({ toolName: fc.name, args: fc.args })
        }
      }
      continue
    }

    // OpenAI: choices[].delta.tool_calls[] fragments keyed by call index — the
    // NAME arrives on the first fragment for a given index, later fragments
    // carry only `function.arguments` text for that same index.
    if (Array.isArray(data.choices)) {
      for (const choice of data.choices as Array<Record<string, unknown>>) {
        const delta = choice?.delta as Record<string, unknown> | undefined
        const calls = delta?.tool_calls
        if (!Array.isArray(calls)) continue
        for (const call of calls as Array<Record<string, unknown>>) {
          const idx = typeof call.index === 'number' ? call.index : 0
          const fn = call.function as Record<string, unknown> | undefined
          const entry = openAiByIndex.get(idx) ?? { name: '', args: '' }
          if (fn && typeof fn.name === 'string' && fn.name) entry.name = fn.name
          if (fn && typeof fn.arguments === 'string') entry.args += fn.arguments
          openAiByIndex.set(idx, entry)
        }
      }
    }
  }

  // Finalize any still-open blocks — the stream may have been cut short (e.g.
  // truncated at the maxBodyBytes inspection cap): best-effort include
  // whatever argument text accumulated so far rather than dropping the call.
  for (const entry of anthropicByIndex.values()) {
    out.push({ toolName: entry.name, args: anthropicArgs(entry) })
  }
  for (const entry of cohereByIndex.values()) {
    if (entry.name) out.push({ toolName: entry.name, args: parseJsonArgs(entry.args) })
  }
  for (const entry of openAiByIndex.values()) {
    if (entry.name) out.push({ toolName: entry.name, args: parseJsonArgs(entry.args) })
  }
  for (const entry of responsesByIndex.values()) {
    out.push({ toolName: entry.name, args: entry.custom ? entry.args : parseJsonArgs(entry.args) })
  }

  return out
}

const ANTHROPIC_TOOL_BLOCKS = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use'])

/** A streamed Anthropic block's arguments: its fragments, or the input its start event carried when none came. */
function anthropicArgs(entry: AnthropicAccum): unknown {
  if (entry.json) return parseJsonArgs(entry.json)
  return entry.input && typeof entry.input === 'object' ? entry.input : {}
}

/** The name and argument text one Cohere v2 tool-call event carries in delta.message.tool_calls.function. */
function cohereStreamPart(data: Record<string, unknown>): { name: string; args: string } {
  const message = (data.delta as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
  let call: unknown = message?.tool_calls
  if (Array.isArray(call)) call = call[0]
  const fn = (call as Record<string, unknown> | undefined)?.function as Record<string, unknown> | undefined
  return { name: typeof fn?.name === 'string' ? fn.name : '', args: typeof fn?.arguments === 'string' ? fn.arguments : '' }
}

/**
 * Tool calls in a Cohere v1 newline-delimited JSON stream: whole in the
 * `tool-calls-generation` event, or assembled from `tool-calls-chunk` deltas
 * when the stream ended before it.
 */
function extractCohereNdjsonCalls(text: string): ScannedToolCall[] {
  const chunks = new Map<number, { name: string; params: string }>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let data: Record<string, unknown>
    try { data = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (data.event_type === 'tool-calls-generation' && Array.isArray(data.tool_calls)) {
      return (data.tool_calls as Array<Record<string, unknown>>)
        .filter(c => c && typeof c.name === 'string')
        .map(c => ({ toolName: c.name as string, args: c.parameters ?? {} }))
    }
    if (data.event_type === 'tool-calls-chunk') {
      const d = data.tool_call_delta as Record<string, unknown> | undefined
      const idx = typeof d?.index === 'number' ? d.index : 0
      const call = chunks.get(idx) ?? { name: '', params: '' }
      if (typeof d?.name === 'string') call.name += d.name
      if (typeof d?.parameters === 'string') call.params += d.parameters
      chunks.set(idx, call)
    }
  }
  return [...chunks.values()].filter(c => c.name).map(c => ({ toolName: c.name, args: parseJsonArgs(c.params) }))
}

function parseJsonArgs(json: string): unknown {
  if (!json) return {}
  try { return JSON.parse(json) } catch { return json }
}

/** Pull the `data:` line(s) out of one raw SSE event block, joined (SSE allows a multi-line data field). Returns null for a block with no data line. */
function parseSseEventData(raw: string): string | null {
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  return dataLines.join('\n')
}

/** Serialize a tool call's arguments (object, string, or anything else) into a scannable text blob for the DLP + URL passes. */
export function serializeToolArgs(args: unknown): string {
  if (typeof args === 'string') return args
  try { return JSON.stringify(args) } catch { return String(args) }
}

// Generic URL matcher — deliberately permissive (stops at whitespace, quotes,
// backslash, angle brackets). It only feeds the existing UrlClassifier, which
// does its own strict host/path parsing and produces the actual verdict.
const URL_RE = /https?:\/\/[^\s"'\\<>]+/g

/** Every URL literal found in a serialized-args text blob, deduped. */
export function extractArgUrls(text: string): string[] {
  if (!text) return []
  const found = new Set<string>()
  URL_RE.lastIndex = 0
  for (let m = URL_RE.exec(text); m !== null; m = URL_RE.exec(text)) {
    found.add(m[0])
    if (m.index === URL_RE.lastIndex) URL_RE.lastIndex++
  }
  return [...found]
}

export interface ToolUseExfilFinding {
  toolName: string
  args: unknown
  dlpFindings: DlpFinding[]
  urlFindings: { url: string; reason: string }[]
}

/**
 * Scan a set of extracted tool calls for exfiltration:
 *   (a) the existing DLP pattern engine over each call's serialized arguments;
 *   (b) the existing UrlClassifier verdict (via the injected predicate) on
 *       every URL literal found in those arguments.
 *
 * Pure — no config/event-bus coupling, so it is unit-testable without a
 * running proxy; the caller (proxy.ts) turns each finding into a dashboard
 * event and decides block/audit, exactly as scanResponseExfil does for the
 * response-exfil scan.
 */
export function scanToolCallsForExfil(
  calls: ScannedToolCall[],
  dlp: DlpScanner,
  isExfilUrl: (hostname: string, path: string) => boolean,
): ToolUseExfilFinding[] {
  const findings: ToolUseExfilFinding[] = []
  for (const call of calls) {
    if (!call.toolName) continue
    const text = serializeToolArgs(call.args)
    const dlpFindings = dlp.scan(text)
    const urlFindings: { url: string; reason: string }[] = []
    for (const url of extractArgUrls(text)) {
      const parsed = parseUrl(url)
      if (parsed && isExfilUrl(parsed.hostname, parsed.path)) {
        urlFindings.push({ url, reason: `URL points at an exfiltration destination (${parsed.hostname})` })
      }
    }
    if (dlpFindings.length > 0 || urlFindings.length > 0) {
      findings.push({ toolName: call.toolName, args: call.args, dlpFindings, urlFindings })
    }
  }
  return findings
}

/**
 * Does this tool name look like it WRITES to long-term memory?
 *
 * Name-based, because the proxy sees the wire protocol and not the semantics
 * of whatever MCP server is behind it. Requires both a memory-ish and a
 * write-ish token so `memory_recall` (a read) does not gate, while
 * `memory_save`, `store_knowledge` and `add_note` do. `remember` is accepted
 * alone because it is a write on its own terms.
 */
export function isMemoryWriteTool(name: string): boolean {
  if (!name) return false
  if (/^(?:remember|memorize|memorise)$/i.test(name)) return true
  const memoryish = /memor|knowledge|recall|note|context|observation/i.test(name)
  const writeish = /save|write|store|add|create|update|upsert|put|insert|append|record|remember/i.test(name)
  return memoryish && writeish
}

export interface ToolUseMemoryFinding {
  toolName: string
  args: unknown
  /** Which memory-poisoning family fired. */
  kind: MemoryPoisoningFinding['kind']
  snippet: string
}

/**
 * Gate what the agent is about to PERSIST.
 *
 * This is the highest-leverage point in the whole memory story. Everywhere
 * else llm-fw re-checks a poisoned memory on every replay; here it stops the
 * memory being written at all, so one block prevents an unbounded number of
 * future recalls. It is also the only place the firewall can act before the
 * damage becomes persistent state outside its view.
 *
 * The obvious limitation, stated so nobody over-trusts this: it only sees
 * writes the MODEL requests as a tool call. A harness that captures memory out
 * of band — a session hook writing observations directly to a local store —
 * never crosses the proxy, and such a memory can only be caught later, on
 * replay. That is containment, not prevention.
 */
export function scanToolCallsForMemoryPoisoning(calls: ScannedToolCall[]): ToolUseMemoryFinding[] {
  const findings: ToolUseMemoryFinding[] = []
  for (const call of calls) {
    if (!call.toolName || !isMemoryWriteTool(call.toolName)) continue
    // `quoted` is deliberately ignored here: the serialized arguments are JSON,
    // so every string value sits inside double quotes.
    const finding = detectMemoryPoisoning(serializeToolArgs(call.args))
    if (finding) {
      findings.push({ toolName: call.toolName, args: call.args, kind: finding.kind, snippet: finding.snippet })
    }
  }
  return findings
}

function parseUrl(u: string): { hostname: string; path: string } | null {
  try {
    const url = new URL(u)
    return { hostname: url.hostname, path: url.pathname + url.search }
  } catch {
    return null
  }
}
