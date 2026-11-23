// Withholding a blocked tool result (detection.surfaces.tool_result.onBlock).
//
// An agent resends its whole history on every request, so refusing a request
// because one tool result in it looked like an injection refuses every later
// request of the session too: replaying 7 days of real Claude Code sessions,
// 32 of 245 outside llm-fw hit a block, and each one ended there. Withholding
// replaces that tool result's text with a notice and lets the request go on.
// The model still never reads the flagged text, which is what refusing was for.
//
// Provider-neutral on purpose: every parser builds a tool result's text from
// string leaves of the body (Anthropic joins text parts with '\n'), so the
// leaves that are pieces of the flagged text are what gets replaced. The caller
// re-extracts the tool results afterwards and refuses as before when the text
// is still there, so a shape this does not reach fails closed.

/** What replaces every part of a withheld text after the first. */
export const WITHHELD_MARKER = '[withheld]'

/**
 * The notice that replaces a withheld text. The same bytes on every request:
 * the agent resends the original each turn, and a notice that changed (an
 * event id, a timestamp) would change the forwarded history there and break
 * the provider's prompt cache from that point on.
 */
export function withholdNotice(surface: 'prompt' | 'tool_result', stage: string): string {
  const what = surface === 'prompt' ? 'earlier message' : 'tool output'
  return `[llm-fw withheld this ${what}: it matched the ${stage} rule. Its content was not passed on to the model.]`
}

const NOTICE = /^\[llm-fw withheld this (?:earlier message|tool output): it matched the [\w-]+ rule\. Its content was not passed on to the model\.\]$/

/**
 * True for a text that is exactly one of llm-fw's own notices, or the marker.
 * They carry nothing anyone wrote, so no stage should score them: live, the
 * classifier scored the notice 99.9% injection on the rescan, withheld it
 * again, which cannot remove it, and refused the request after all.
 */
export function isWithholdNotice(text: string): boolean {
  const t = text.trim()
  return t === WITHHELD_MARKER || NOTICE.test(t)
}

/** Keys that hold structure (ids, roles, block types, names), never output. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'type', 'role', 'id', 'tool_use_id', 'tool_call_id', 'call_id', 'name', 'model', 'media_type', 'cache_control',
])

/**
 * Shortest leaf replaced, unless the whole flagged text is shorter: a short
 * leaf such as "ok" or a block type is far more likely to occur in the flagged
 * text by chance than to be a part of it.
 */
const MIN_PART = 24

/**
 * Whether a value can be one of the parts the parser joined into `text`: the
 * whole of it, or a run of whole lines, since every parser joins parts with
 * a line break. A leaf that is only somewhere inside a line is a coincidence
 * (#530).
 *
 * Built once per text, so the cost is the body's size, not its leaves times
 * the text's (#917: 20,000 blocks of a 710 KB tool result took 1.2 s, each
 * leaf searching the whole text). A value of one line, which every
 * serialized value is, is looked up among the text's lines. One of several
 * lines must start and end on lines of the text, and is searched from where
 * the last part of its group was found: a tool result's parts come in order.
 * Past a total of 64 searches of the whole text it gives up, and the caller
 * refuses the request rather than holding the thread.
 */
class PartFinder {
  private readonly lines: Set<string>
  private readonly padded: string
  private budget: number
  private readonly from = new Map<string, number>()
  exhausted = false

  constructor(private readonly text: string) {
    this.lines = new Set(text.split('\n'))
    this.padded = `\n${text}\n`
    this.budget = 64 * this.padded.length
  }

  isPart(v: string, group: string): boolean {
    if (v === this.text) return true
    const nl = v.indexOf('\n')
    if (nl === -1) return this.lines.has(v)
    if (!this.lines.has(v.slice(0, nl)) || !this.lines.has(v.slice(v.lastIndexOf('\n') + 1))) return false
    const needle = `\n${v}\n`
    const hint = this.from.get(group) ?? 0
    for (const start of hint > 0 ? [hint, 0] : [0]) {
      if (this.budget <= 0) { this.exhausted = true; return false }
      const at = this.padded.indexOf(needle, start)
      this.budget -= (at === -1 ? this.padded.length : at + needle.length) - start
      if (at !== -1) { this.from.set(group, at + needle.length - 1); return true }
    }
    return false
  }
}

interface Leaf {
  holder: Record<string, unknown>
  key: string
  length: number
  /** Under the shortest part: replaced with its tool result, never what chooses one. */
  short?: boolean
  /** A structured value the parser serialized whole: replaced by a text block. */
  node?: unknown
}

/**
 * Blocks that hold one tool result. Each is a group of its own (#917): grouped
 * by message, parallel results in one message were one group, and a block two
 * of them shared took the innocent one with the flagged one.
 */
const TOOL_RESULT_TYPES: ReadonlySet<string> = new Set(['tool_result', 'function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'mcp_call'])
const TOOL_RESULT_KEYS = ['toolResult', 'functionResponse', 'function_response'] as const
function isToolResultBlock(value: Record<string, unknown>): boolean {
  return (typeof value.type === 'string' && TOOL_RESULT_TYPES.has(value.type)) || TOOL_RESULT_KEYS.some(k => k in value) || value.role === 'tool'
}

/**
 * Deepest structured value tried whole, from its message: the parsers
 * serialize a tool result's content or one of its blocks, which sit at most
 * six levels down (Bedrock's messages[i].content[j].toolResult.content[k]).
 * Bounded so serializing does not cost the body's size once per level.
 */
const MAX_NODE_DEPTH = 8

/**
 * What replaces a structured value, in the shape its place takes: a content
 * block in an array (with Anthropic's `type` when the value had one), a Gemini
 * functionResponse's `response` as its `output`, which the parser reads as
 * the text, and a text block anywhere else. The parsers read each back as the
 * notice alone, so no stage scores it.
 */
function nodeReplacement(holder: Record<string, unknown>, key: string, node: unknown, text: string): unknown {
  if (Array.isArray(holder)) return node && typeof node === 'object' && 'type' in node ? { type: 'text', text } : { text }
  if (key === 'response') return { output: text }
  return { text }
}

/**
 * `body` with the flagged text replaced. The body is split into messages: an
 * element of a top-level array (`messages`, `input`, `contents`, `system`
 * blocks) or a top-level field (`system`, `instructions`). In each message
 * whose leaves cover the most of `text`, every leaf that is a part of it is
 * replaced: the first by `notice`, any further ones by a short marker, so a
 * multi-part result keeps its block structure and no text block becomes
 * empty. A message the flagged text only quotes from, or shares a delimiter
 * line with, covers less of it and is left alone; an exact copy, which a
 * resent history holds, covers as much and is replaced too (#530). Null when
 * the body is not JSON or no leaf matched.
 */
export function withholdText(body: string, text: string, notice: string): string | null {
  let data: unknown
  try { data = JSON.parse(body) } catch { return null }
  // A body that is a bare string or a top-level array of strings is not a
  // request any parser reads, so only objects are walked.
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const min = Math.min(text.length, MIN_PART)
  const parts = new PartFinder(text)
  const groups = new Map<string, Leaf[]>()
  const add = (group: string, leaf: Leaf): void => {
    const leaves = groups.get(group) ?? []
    leaves.push(leaf)
    groups.set(group, leaves)
  }
  // `inResult`: inside one tool result, where a short part and a structured
  // value are read too. `path` names a tool-result block's own group.
  const visit = (holder: Record<string, unknown>, key: string, value: unknown, group: string, inResult: boolean, depth: number, path: string): void => {
    if (typeof value === 'string') {
      if (STRUCTURAL_KEYS.has(key) || value.length === 0 || !parts.isPart(value, group)) return
      if (value.length >= min) add(group, { holder, key, length: value.length })
      else if (inResult) add(group, { holder, key, length: value.length, short: true })
      return
    }
    if (!value || typeof value !== 'object') return
    // A tool result's structured content, or one block of it, the parser
    // serialized whole (#917): no string leaf sits on a line of that text.
    if (inResult && depth > 0 && depth <= MAX_NODE_DEPTH) {
      const json = JSON.stringify(value)
      if (json.length >= min && parts.isPart(json, group)) {
        add(group, { holder, key, length: json.length, node: value })
        return
      }
    }
    if (!Array.isArray(value) && isToolResultBlock(value as Record<string, unknown>)) {
      group = `${group}>${path}`
      inResult = true
    }
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) visit(value as unknown as Record<string, unknown>, String(i), v, group, inResult, depth + 1, `${path}/${i}`)
    } else {
      for (const [k, v] of Object.entries(value)) visit(value as Record<string, unknown>, k, v, group, inResult, depth + 1, `${path}/${k}`)
    }
  }
  // Google's Cloud Code API (Antigravity, Gemini CLI) wraps the Gemini request
  // in `request` (#594), so its messages are one level down. Grouped at the
  // envelope, the whole conversation was one message.
  const envelope = data as Record<string, unknown>
  const inner = envelope.request
  const top = !('contents' in envelope) && inner && typeof inner === 'object' && Array.isArray((inner as Record<string, unknown>).contents)
    ? inner as Record<string, unknown>
    : envelope
  for (const [k, v] of Object.entries(top)) {
    if (!Array.isArray(v)) { visit(top, k, v, k, false, 0, k); continue }
    // Cohere v1 sends each tool result as an element of `tool_results`.
    for (const [i, el] of v.entries()) visit(v as unknown as Record<string, unknown>, String(i), el, `${k}#${i}`, k === 'tool_results', 0, '')
  }
  if (parts.exhausted) return null
  const covered = (leaves: Leaf[]): number => leaves.reduce((n, l) => n + (l.short ? 0 : l.length), 0)
  const best = Math.max(0, ...[...groups.values()].map(covered))
  if (best === 0) return null
  for (const leaves of groups.values()) {
    if (covered(leaves) < best) continue
    leaves.forEach((l, i) => {
      const replacement = i === 0 ? notice : WITHHELD_MARKER
      l.holder[l.key] = l.node === undefined ? replacement : nodeReplacement(l.holder, l.key, l.node, replacement)
    })
  }
  return JSON.stringify(data)
}
