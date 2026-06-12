// Multi-turn crescendo jailbreak detector.
//
// A crescendo attack (Russinovich et al., 2024) never asks for the harmful
// payload outright. It opens benign, then escalates over several turns —
// each request referencing the model's own prior compliance ("go on", "now
// give me the complete working version", "remove the disclaimers") — until the
// model has been walked across the line one small step at a time. No single
// turn trips a per-prompt detector.
//
// LLM API requests resend the WHOLE conversation each turn, so the escalation
// trajectory is visible inside one request's message array — no server-side
// session state is needed. The signature this detector keys on: a genuine
// multi-turn conversation whose FINAL user turn is a boundary-pushing
// escalation directive, where the conversation has been steering toward
// concrete harmful content. A benign multi-turn chat that ends with "continue"
// carries no weapons/cyber vocabulary, so it does not fire.

import { ConversationTurn } from '../types.js'
import { containsHarmfulVocab } from './manyShot.js'

export interface CrescendoConfig {
  enabled: boolean
  /** Minimum user turns for a conversation to count as multi-turn. */
  minUserTurns: number
  /** 'block' acts on a harmful crescendo; 'audit' only ever warns. */
  mode: 'audit' | 'block'
}

export interface CrescendoResult {
  userTurns: number
  /** The final user turn is a boundary-pushing escalation directive. */
  finalEscalation: boolean
  /** The conversation references concrete harmful-domain content. */
  harmfulContext: boolean
  severity: 'none' | 'warn' | 'block'
}

// Boundary-pushing escalation directives — the operational tell of a crescendo's
// final turn: demand the full/real/working payload, or strip the model's hedging.
// Distinct from a benign "continue" (which is in CONTINUATION below) because
// these explicitly push past a limit.
const BOUNDARY_PUSH =
  /(?:now |finally |ok(?:ay)? |so )?(?:give|show|write|provide|tell)\s+me\s+(?:the\s+)?(?:full|complete|real|actual|working|exact|detailed|precise|entire|whole|step[- ]?by[- ]?step)\b/i

const BOUNDARY_PUSH_ALT = [
  /\b(?:remove|drop|skip|omit|without)\s+(?:the\s+|any\s+|all\s+)?(?:disclaimers?|warnings?|caveats?|hedging|safety\s+(?:notice|warning)s?)/i,
  /\bstop\s+(?:hedging|refusing|moralizing|moralising|warning me|with the (?:warnings|disclaimers))/i,
  /\bno\s+more\s+(?:hedging|warnings|disclaimers|caveats|refusals)/i,
  /\bnow\s+(?:actually\s+)?(?:do\s+it|answer\s+(?:it|fully|properly)|write\s+it|give\s+it\s+to\s+me)\b/i,
  /\b(?:go\s+(?:deeper|further)|be\s+more\s+specific|more\s+detail|expand\s+on\s+(?:that|step|it))\b/i,
  /\b(?:combine|put\s+(?:it|them)\s+together|assemble)\b[^.!?]{0,30}\b(?:steps?|parts?|pieces?|code|instructions?)\b/i,
]

// Plain continuation cues — alone these are usually benign ("go on"), so they
// only contribute when the conversation also carries harmful context.
const CONTINUATION =
  /^\s*(?:continue|go on|keep going|and then\??|what(?:'s| is) next\??|next step\??|proceed|carry on|more\??)\s*[.!?]*\s*$/i

function isEscalation(text: string): boolean {
  if (BOUNDARY_PUSH.test(text)) return true
  if (BOUNDARY_PUSH_ALT.some(re => re.test(text))) return true
  // A bare continuation directive counts only when it is the whole short turn.
  return text.trim().length <= 40 && CONTINUATION.test(text)
}

/**
 * Detect a multi-turn crescendo in an ordered conversation.
 *
 * Blocks when a genuine multi-turn conversation ends on a boundary-pushing
 * escalation directive AND the conversation has been steering toward concrete
 * harmful content (harmful vocabulary in an earlier turn, not only the final
 * one — the gradual build-up is the point). Pure and linear in turn count.
 */
export function detectCrescendo(turns: ConversationTurn[], config: CrescendoConfig): CrescendoResult {
  const none: CrescendoResult = { userTurns: 0, finalEscalation: false, harmfulContext: false, severity: 'none' }
  if (!turns || turns.length === 0) return none

  const userTurns = turns.filter(t => t.role === 'user')
  if (userTurns.length < config.minUserTurns) {
    return { userTurns: userTurns.length, finalEscalation: false, harmfulContext: false, severity: 'none' }
  }

  const finalUser = userTurns[userTurns.length - 1]
  const finalEscalation = !!finalUser && isEscalation(finalUser.text)

  // Harmful context must appear in an EARLIER turn (any role) — the crescendo
  // builds the harmful subject across the conversation, then the final turn
  // merely escalates. Requiring it earlier (not only in the final turn)
  // distinguishes a true crescendo from a one-shot harmful ask.
  const earlier = turns.slice(0, -1)
  const harmfulContext = earlier.some(t => containsHarmfulVocab(t.text))

  let severity: CrescendoResult['severity'] = 'none'
  if (finalEscalation && harmfulContext) severity = 'block'
  if (config.mode === 'audit' && severity === 'block') severity = 'warn'

  return { userTurns: userTurns.length, finalEscalation, harmfulContext, severity }
}
