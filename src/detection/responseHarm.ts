// Response-side harmful-compliance detection (defense-in-depth).
//
// Input-side detection stops the overwhelming majority of jailbreaks, but no
// pre-filter is perfect: a novel phrasing can slip past and the model may
// actually comply, returning operational harmful content. This audit-only scan
// reads the model's RESPONSE and flags the case where it produced a harmful
// HOW-TO — concrete weapons/cyber/illicit vocabulary appearing next to
// procedural-compliance language ("step 1", "you will need", "combine the…").
//
// It is deliberately audit-only (visibility, never block): output-content
// classification is inherently fuzzier than input-injection matching, and a
// blocked response can't be cleanly "neutralized" the way an exfil URL can. A
// flag tells the operator a jailbreak likely succeeded so they can tighten the
// input rules — without risking false-blocking a legitimate security answer.
//
// Precision comes from REQUIRING co-occurrence (harmful noun + procedural
// marker in proximity) and EXCLUDING refusals: "I can't help you build a bomb"
// mentions a harmful noun but carries a refusal marker and no procedure, so it
// does not fire.

import { HARMFUL_TERMS } from './manyShot.js'

export interface HarmComplianceFinding {
  /** The harmful-domain term that co-occurred with procedural language. */
  term: string
  /** A short snippet around the match, for the dashboard event. */
  snippet: string
}

const harmfulRe = new RegExp(
  '\\b(' + HARMFUL_TERMS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
  'i',
)

// Procedural / compliance language that signals an actual how-to is being given
// (as opposed to merely naming the topic). Co-occurrence with a harmful term is
// the compliance signal.
const PROCEDURAL_RE =
  /\b(step\s*\d|step[- ]by[- ]step|first(?:,| you| ,)|you(?:'?ll| will)?\s+need|you\s+(?:can|should|must|would)\s+\w+|combine|mix(?:ture)?|ingredients?|materials?|required\s+(?:items?|materials?|components?)|here(?:'?s| is| are)\s+how|to\s+(?:make|build|create|synthesi[sz]e|produce|assemble|construct)\b|the\s+process\s+(?:is|begins|starts)|recipe|quantit(?:y|ies)|ratio\s+of|grams?\s+of|ml\s+of)\b/i

// Refusal language — when present near a harmful term, the model declined, so
// the harmful noun is part of a refusal, not compliance.
const REFUSAL_RE =
  /\b(i\s+(?:can'?t|cannot|won'?t|am\s+not\s+able|am\s+unable|will\s+not)|i'?m\s+(?:sorry|not\s+able|unable)|i\s+do\s+not\s+(?:provide|assist|help)|cannot\s+(?:help|assist|provide|comply)|can'?t\s+(?:help|assist|provide)|not\s+able\s+to\s+(?:help|provide|assist)|against\s+(?:my|our)\s+(?:policy|guidelines)|i\s+must\s+decline)\b/i

/**
 * Scan a model response for harmful compliance.
 *
 * Returns a finding when a harmful-domain term appears within ~200 characters
 * of procedural-compliance language AND that local window is not a refusal.
 * Pure; operates on the raw decoded response text (URLs/JSON wrappers are
 * harmless noise — the co-occurrence is what matters). Returns null otherwise.
 */
export function detectHarmfulCompliance(text: string): HarmComplianceFinding | null {
  if (!text || text.length < 8) return null

  harmfulRe.lastIndex = 0
  let m: RegExpExecArray | null
  const re = new RegExp(harmfulRe.source, 'gi')
  while ((m = re.exec(text)) !== null) {
    const term = m[1] ?? m[0]
    const start = Math.max(0, m.index - 200)
    const end = Math.min(text.length, m.index + term.length + 200)
    const window = text.slice(start, end)
    if (REFUSAL_RE.test(window)) continue
    if (PROCEDURAL_RE.test(window)) {
      const snipStart = Math.max(0, m.index - 60)
      const snipEnd = Math.min(text.length, m.index + term.length + 60)
      return { term: term.toLowerCase(), snippet: text.slice(snipStart, snipEnd).replace(/\s+/g, ' ').trim() }
    }
  }
  return null
}
