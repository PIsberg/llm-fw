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
 * Whether `v` can be one of the parts the parser joined into `text`: the
 * whole of it, or a run of whole lines, since every parser joins parts with
 * a line break. A leaf that is only somewhere inside a line is a coincidence
 * (#530).
 */
function isPart(text: string, v: string): boolean {
  return v === text || text.startsWith(`${v}\n`) || text.endsWith(`\n${v}`) || text.includes(`\n${v}\n`)
}

interface Leaf { holder: Record<string, unknown>; key: string; length: number }

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
  const groups = new Map<string, Leaf[]>()
  const visit = (holder: Record<string, unknown>, key: string, value: unknown, group: string): void => {
    if (typeof value === 'string') {
      if (STRUCTURAL_KEYS.has(key) || value.length < min || !isPart(text, value)) return
      const leaves = groups.get(group) ?? []
      leaves.push({ holder, key, length: value.length })
      groups.set(group, leaves)
    } else if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) visit(value as unknown as Record<string, unknown>, String(i), v, group)
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(value as Record<string, unknown>, k, v, group)
    }
  }
  const top = data as Record<string, unknown>
  for (const [k, v] of Object.entries(top)) {
    if (!Array.isArray(v)) { visit(top, k, v, k); continue }
    for (const [i, el] of v.entries()) visit(v as unknown as Record<string, unknown>, String(i), el, `${k}#${i}`)
  }
  if (groups.size === 0) return null
  const covered = (leaves: Leaf[]): number => leaves.reduce((n, l) => n + l.length, 0)
  const best = Math.max(...[...groups.values()].map(covered))
  for (const leaves of groups.values()) {
    if (covered(leaves) < best) continue
    leaves.forEach((l, i) => { l.holder[l.key] = i === 0 ? notice : '[withheld]' })
  }
  return JSON.stringify(data)
}
