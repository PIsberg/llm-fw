// The false-positive triage view of an event (#811): what an operator or an
// agent needs to decide whether a block was a false positive, and none of the
// blocked text.
//
// payload_preview starts with the text that was blocked, and its label quotes
// the word that fired. An agent behind this firewall that printed the preview
// to triage a block had its own output withheld for the same reason, on the
// very step meant to decide. Everything here is built from structured fields
// (stage, kind, rule ids, lengths), never from payload text, so printing a
// triage row cannot repeat what was blocked.
import type { BlockEvent, ScanSource } from '../types.js'

export interface TriageRow {
  id: string
  timestamp: string
  action: BlockEvent['action']
  stage: string
  /** The stage and the rule that fired (eventRule): an identifier, never the matched text. */
  rule: string
  /** The surface the text arrived on, when the block was about one scanned text. */
  surface?: ScanSource
  score: number
  similarity: number
  /** Characters in the blocked text. */
  length: number
  target: string
  client?: string
  /** True when "Mark false positive" can act on it (POST /api/feedback). */
  markable: boolean
  /** A mark for this text is in the suppression list. */
  marked: boolean
  /** It is in whitelist.json ("Record as false positive"). */
  recorded: boolean
  withheld?: boolean
  /** False under observe: the verdict was recorded, the request forwarded. */
  enforced?: boolean
}

// An identifier: a rule label, a DLP type, an MCP category. Anything else, a
// reason written as a sentence, is left out rather than risk quoting text.
const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/

// The display line the pipeline writes for this stage (pipeline.ts):
// "[indirect: <reason> \"<verb>\"] <snippet>", or "[indirect: planted <shape>]",
// behind an optional surface label. Only the reason and shape are kept.
const INDIRECT_LABEL = /^(?:\[[a-z-]+\] )*\[indirect: (secret-file [a-z]+|planted [a-z0-9-]+|[a-z-]+)[\] ]/

function ident(value: string | undefined): string | undefined {
  return value !== undefined && IDENT.test(value) ? value : undefined
}

/**
 * The stage and the rule that fired, as one identifier with underscores for
 * hyphens: `heuristic:system_override`. Underscores because the hyphenated
 * label is itself text the heuristic stage blocks ("system-override" scores 50,
 * the block threshold), so a listing that printed it was withheld like the
 * payload it described.
 */
export function eventRule(event: BlockEvent): string {
  return ruleOf(event).replace(/-/g, '_')
}

function ruleOf(event: BlockEvent): string {
  const base = event.kind !== undefined && event.kind !== 'prompt' ? event.kind : event.stage
  if (event.stage === 'indirect-instruction') {
    const m = INDIRECT_LABEL.exec(event.payload_preview ?? '')
    const detail = m?.[1]?.split(' ').every(part => IDENT.test(part)) ? m[1] : undefined
    return detail ? `${base}:${detail}` : base
  }
  const matches = (event.heuristicMatches ?? []).filter(m => IDENT.test(m))
  if (matches.length > 0 && matches.length === (event.heuristicMatches ?? []).length) return `${base}:${matches.join('+')}`
  const detail = ident(event.dlpType) ?? ident(event.mcpRule) ?? ident(event.ragTag)
  return detail ? `${base}:${detail}` : base
}

export function triageRow(event: BlockEvent, state: { marked: boolean; recorded: boolean }): TriageRow {
  const text = event.payload_full || event.payload_preview || ''
  return {
    id: event.id,
    timestamp: event.timestamp,
    action: event.action,
    stage: event.stage,
    rule: eventRule(event),
    ...(event.suppressionSource ? { surface: event.suppressionSource } : {}),
    score: event.score,
    similarity: event.similarity,
    length: text.length,
    target: event.target,
    ...(event.sandboxClient ? { client: event.sandboxClient } : {}),
    markable: event.action === 'blocked' && event.suppressionKey !== undefined,
    marked: state.marked,
    recorded: state.recorded,
    ...(event.withheld !== undefined ? { withheld: event.withheld } : {}),
    ...(event.enforced !== undefined ? { enforced: event.enforced } : {}),
  }
}
