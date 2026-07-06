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

import type { PayloadParser, DlpFinding } from '../types.js'
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

interface AnthropicAccum { name: string; json: string }
interface OpenAiAccum { name: string; args: string }

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
  const out: ScannedToolCall[] = []
  const anthropicByIndex = new Map<number, AnthropicAccum>()
  const openAiByIndex = new Map<number, OpenAiAccum>()

  for (const raw of sseText.split('\n\n')) {
    if (!raw.trim()) continue
    const payload = parseSseEventData(raw)
    if (payload === null || payload === '[DONE]') continue

    let data: Record<string, unknown>
    try { data = JSON.parse(payload) as Record<string, unknown> } catch { continue }

    const type = typeof data.type === 'string' ? data.type : undefined
    const index = typeof data.index === 'number' ? data.index : undefined

    // Anthropic: content_block_start (tool_use, name) -> content_block_delta
    // (input_json_delta, partial_json fragments) -> content_block_stop.
    if (type === 'content_block_start' && index !== undefined) {
      const block = data.content_block as Record<string, unknown> | undefined
      if (block && block.type === 'tool_use' && typeof block.name === 'string') {
        anthropicByIndex.set(index, { name: block.name, json: '' })
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
      out.push({ toolName: entry.name, args: parseJsonArgs(entry.json) })
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
      continue
    }
  }

  // Finalize any still-open blocks — the stream may have been cut short (e.g.
  // truncated at the maxBodyBytes inspection cap): best-effort include
  // whatever argument text accumulated so far rather than dropping the call.
  for (const entry of anthropicByIndex.values()) {
    out.push({ toolName: entry.name, args: parseJsonArgs(entry.json) })
  }
  for (const entry of openAiByIndex.values()) {
    if (entry.name) out.push({ toolName: entry.name, args: parseJsonArgs(entry.args) })
  }

  return out
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
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
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

function parseUrl(u: string): { hostname: string; path: string } | null {
  try {
    const url = new URL(u)
    return { hostname: url.hostname, path: url.pathname + url.search }
  } catch {
    return null
  }
}
