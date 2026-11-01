// Requests rebuilt from the agents' own local transcripts, for replaying real
// traffic through the pipeline (scripts/replay-transcripts.ts).
//
// Every false positive that reached the user so far was traffic no corpus held:
// Claude Code's and Codex's own wrappers, skill bodies, tool output quoting a
// security doc. The transcripts on the user's machine are that traffic, so they
// are the measure of "does ordinary use block". They are private: nothing here
// or in the script writes them anywhere but the path the caller names.
//
// One replay item is one scan unit as the proxy sees it:
//   - a Claude Code user message: its text blocks, sent as one message, so the
//     parser splits them per block exactly as on the wire (the envelope of a
//     model-invoked skill is a block of its own before the skill body);
//   - a Claude Code tool result, after the assistant tool_use that asked for
//     it, so tool-name and trusted-path decisions see what they see live;
//   - a Claude Code attachment (a system-reminder Claude Code renders into the
//     next user turn) as a text block;
//   - a Codex user message, or a Codex tool output after its call, in the
//     Responses API shape Codex records them in.
// Identical items are kept once: the history is resent on every request, and
// the pipeline caches per item, so one scan per distinct item is what counts.
import { createHash } from 'node:crypto'

export type ReplayClient = 'claude-code' | 'codex'
export type ReplayKind = 'prompt' | 'tool_result' | 'reminder'

export interface ReplayItem {
  /** sha1 of client, kind and body: stable across runs, so two runs can be diffed. */
  key: string
  client: ReplayClient
  kind: ReplayKind
  /** Request path the proxy would see. */
  path: '/v1/messages' | '/v1/responses'
  target: 'api.anthropic.com' | 'api.openai.com'
  body: string
  file: string
}

const MODEL = { 'claude-code': 'claude-opus-5-5', codex: 'gpt-5' } as const

function item(client: ReplayClient, kind: ReplayKind, payload: Record<string, unknown>, file: string): ReplayItem {
  const body = JSON.stringify({ model: MODEL[client], ...(client === 'claude-code' ? { max_tokens: 1024 } : {}), ...payload })
  return {
    key: createHash('sha1').update(`${client}\0${kind}\0${body}`).digest('hex'),
    client,
    kind,
    path: client === 'claude-code' ? '/v1/messages' : '/v1/responses',
    target: client === 'claude-code' ? 'api.anthropic.com' : 'api.openai.com',
    body,
    file,
  }
}

function parseLines(text: string): any[] {
  const out: any[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a torn last line while the session runs */ }
  }
  return out
}

const isText = (b: any): boolean => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== ''

/** Replay items from one Claude Code transcript (`~/.claude/projects/<project>/<session>.jsonl`). */
export function claudeCodeItems(text: string, file: string): ReplayItem[] {
  const items: ReplayItem[] = []
  const toolUses = new Map<string, unknown>()
  for (const r of parseLines(text)) {
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      for (const b of r.message.content) if (b?.type === 'tool_use' && typeof b.id === 'string') toolUses.set(b.id, b)
      continue
    }
    if (r.type === 'attachment' && Array.isArray(r.rendered)) {
      const blocks = r.rendered.filter((x: any) => typeof x?.content === 'string' && x.content.trim()).map((x: any) => ({ type: 'text', text: x.content }))
      if (blocks.length) items.push(item('claude-code', 'reminder', { messages: [{ role: 'user', content: blocks }] }, file))
      continue
    }
    if (r.type !== 'user' || r.message?.role !== 'user') continue
    const c = r.message.content
    if (typeof c === 'string') {
      if (c.trim()) items.push(item('claude-code', 'prompt', { messages: [{ role: 'user', content: [{ type: 'text', text: c }] }] }, file))
      continue
    }
    if (!Array.isArray(c)) continue
    const texts = c.filter(isText)
    if (texts.length) items.push(item('claude-code', 'prompt', { messages: [{ role: 'user', content: texts }] }, file))
    for (const b of c) {
      if (b?.type !== 'tool_result') continue
      const use = typeof b.tool_use_id === 'string' ? toolUses.get(b.tool_use_id) : undefined
      const messages = use ? [{ role: 'assistant', content: [use] }, { role: 'user', content: [b] }] : [{ role: 'user', content: [b] }]
      items.push(item('claude-code', 'tool_result', { messages }, file))
    }
  }
  return items
}

const CODEX_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'])
const CODEX_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call'])

/** Replay items from one Codex transcript (`~/.codex/sessions/YYYY/MM/DD/*.jsonl`). */
export function codexItems(text: string, file: string): ReplayItem[] {
  const items: ReplayItem[] = []
  const calls = new Map<string, unknown>()
  for (const r of parseLines(text)) {
    if (r.type !== 'response_item' || !r.payload) continue
    const p = r.payload
    if (CODEX_CALLS.has(p.type) && typeof p.call_id === 'string') { calls.set(p.call_id, p); continue }
    if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
      if (p.content.some((x: any) => typeof x?.text === 'string' && x.text.trim())) items.push(item('codex', 'prompt', { input: [p] }, file))
      continue
    }
    if (CODEX_OUTPUTS.has(p.type)) {
      const call = typeof p.call_id === 'string' ? calls.get(p.call_id) : undefined
      items.push(item('codex', 'tool_result', { input: call ? [call, p] : [p] }, file))
    }
  }
  return items
}

/** Distinct items, first occurrence kept. */
export function dedupe(items: Iterable<ReplayItem>): ReplayItem[] {
  const seen = new Set<string>()
  const out: ReplayItem[] = []
  for (const it of items) {
    if (seen.has(it.key)) continue
    seen.add(it.key)
    out.push(it)
  }
  return out
}
