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
 * `body` with every string leaf that is a part of `text` replaced: the first by
 * `notice`, any further ones by a short marker, so a multi-part result keeps
 * its block structure and no text block becomes empty. Null when the body is
 * not JSON or no leaf matched.
 */
export function withholdText(body: string, text: string, notice: string): string | null {
  let data: unknown
  try { data = JSON.parse(body) } catch { return null }
  const min = Math.min(text.length, MIN_PART)
  let replaced = 0
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== 'object') return node
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === 'string' && !STRUCTURAL_KEYS.has(k) && v.length >= min && text.includes(v)) {
        out[k] = replaced++ === 0 ? notice : '[withheld]'
      } else {
        out[k] = typeof v === 'object' ? walk(v) : v
      }
    }
    return out
  }
  // A body that is a bare string or a top-level array of strings is not a
  // request any parser reads, so only objects are walked.
  const next = walk(data)
  return replaced > 0 ? JSON.stringify(next) : null
}
