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
  /**
   * Opt-in cross-request escalation memory (Task B4). When a single request's
   * own conversation is shorter than minUserTurns (e.g. a caller that only
   * forwards the latest turn per call instead of resending full history),
   * merge a per-session ring buffer of recent requests' escalation signal
   * before scoring — see CrescendoSessionMemory below. Default false/absent:
   * a shared/multi-tenant proxy risks bleeding one client's history into
   * another's if the session identity collides (NAT, corporate egress), and
   * the memory itself is unbounded-growth risk if enabled carelessly.
   */
  crossRequest?: boolean
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
 * Cross-request signal merged into a scoring call when the request's OWN
 * conversation is shorter than crescendo.minUserTurns. `extraUserTurns` counts
 * toward the minimum-turns gate; `priorHarmfulContext` substitutes for
 * "harmful vocabulary in an earlier turn" when this request's own history has
 * none (e.g. the escalation and the harmful build-up were split across
 * separate single-turn requests). See CrescendoSessionMemory.
 */
export interface CrescendoSessionContext {
  extraUserTurns: number
  priorHarmfulContext: boolean
}

/**
 * Detect a multi-turn crescendo in an ordered conversation.
 *
 * Blocks when a genuine multi-turn conversation ends on a boundary-pushing
 * escalation directive AND the conversation has been steering toward concrete
 * harmful content (harmful vocabulary in an earlier turn, not only the final
 * one — the gradual build-up is the point). Pure and linear in turn count.
 *
 * `sessionContext` (optional) folds in cross-request memory: it can push the
 * total user-turn count over `minUserTurns` and/or satisfy the "earlier
 * harmful context" requirement using signal from PRIOR requests in the same
 * session, but the final-turn escalation check always looks at THIS request's
 * own last user turn — only the request making the ask can trip the block.
 */
export function detectCrescendo(
  turns: ConversationTurn[],
  config: CrescendoConfig,
  sessionContext?: CrescendoSessionContext
): CrescendoResult {
  const none: CrescendoResult = { userTurns: 0, finalEscalation: false, harmfulContext: false, severity: 'none' }
  if (!turns || turns.length === 0) return none

  const userTurns = turns.filter(t => t.role === 'user')
  const extraUserTurns = sessionContext?.extraUserTurns ?? 0
  const totalUserTurns = userTurns.length + extraUserTurns
  if (totalUserTurns < config.minUserTurns) {
    return { userTurns: totalUserTurns, finalEscalation: false, harmfulContext: false, severity: 'none' }
  }

  const finalUser = userTurns[userTurns.length - 1]
  const finalEscalation = !!finalUser && isEscalation(finalUser.text)

  // Harmful context must appear in an EARLIER turn (any role) — the crescendo
  // builds the harmful subject across the conversation, then the final turn
  // merely escalates. Requiring it earlier (not only in the final turn)
  // distinguishes a true crescendo from a one-shot harmful ask. Cross-request
  // memory can also satisfy this when the build-up happened in prior requests.
  const earlier = turns.slice(0, -1)
  const harmfulContext = earlier.some(t => containsHarmfulVocab(t.text)) || (sessionContext?.priorHarmfulContext ?? false)

  let severity: CrescendoResult['severity'] = 'none'
  if (finalEscalation && harmfulContext) severity = 'block'
  if (config.mode === 'audit' && severity === 'block') severity = 'warn'

  return { userTurns: totalUserTurns, finalEscalation, harmfulContext, severity }
}

// ---------------------------------------------------------------------------
// Cross-request session memory (Task B4, opt-in via crescendo.crossRequest)
// ---------------------------------------------------------------------------

interface CrescendoMemoryEntry {
  /** User turns this single request itself contributed. */
  userTurns: number
  /** Whether harmful vocabulary appeared anywhere in this request's own turns. */
  harmfulVocab: boolean
  ts: number
}

interface CrescendoSessionRecord {
  entries: CrescendoMemoryEntry[]
  lastSeen: number
}

const SESSION_TTL_MS = 30 * 60 * 1000
const MAX_SESSIONS = 500
const RING_SIZE = 8

/**
 * Opt-in per-session escalation memory. Keyed by the SAME session identity
 * the proxy already uses for its other per-client state (see
 * `normalizeIp(...remoteAddress)` in src/proxy/proxy.ts, shared with
 * TaintTracker's sessionKey) — this module never invents its own identity.
 *
 * Shape mirrors TaintTracker (src/detection/taint.ts): a Map of session ->
 * ring buffer, TTL-bounded per entry, LRU-evicted by `lastSeen` once the
 * session count exceeds MAX_SESSIONS, so the process cannot be made to grow
 * memory without bound by a flood of distinct client IPs.
 *
 * Deliberately stores a per-request SUMMARY (turn count + a harmful-vocab
 * flag), not the raw prompt text — enough to fold into `detectCrescendo` via
 * CrescendoSessionContext without retaining conversation content in memory
 * for the TTL window.
 */
export class CrescendoSessionMemory {
  private sessions = new Map<string, CrescendoSessionRecord>()

  /** Record this request's own conversation contribution against a session. */
  record(sessionKey: string, turns: ConversationTurn[], now: number = Date.now()): void {
    const userTurns = turns.filter(t => t.role === 'user').length
    if (userTurns === 0) return // nothing to remember (no user turn to escalate from)

    const harmfulVocab = turns.some(t => containsHarmfulVocab(t.text))

    let session = this.sessions.get(sessionKey)
    if (!session) {
      session = { entries: [], lastSeen: now }
      this.sessions.set(sessionKey, session)
    }
    session.entries.push({ userTurns, harmfulVocab, ts: now })
    if (session.entries.length > RING_SIZE) session.entries.shift()
    session.lastSeen = now

    this.evict(now)
  }

  /** Aggregate this session's live (non-expired) entries into scoring context. */
  getContext(sessionKey: string, now: number = Date.now()): CrescendoSessionContext {
    const session = this.sessions.get(sessionKey)
    if (!session) return { extraUserTurns: 0, priorHarmfulContext: false }

    const live = session.entries.filter(e => now - e.ts <= SESSION_TTL_MS)
    return {
      extraUserTurns: live.reduce((sum, e) => sum + e.userTurns, 0),
      priorHarmfulContext: live.some(e => e.harmfulVocab),
    }
  }

  private evict(now: number): void {
    for (const [key, session] of this.sessions) {
      session.entries = session.entries.filter(e => now - e.ts <= SESSION_TTL_MS)
      if (session.entries.length === 0) this.sessions.delete(key)
    }
    if (this.sessions.size > MAX_SESSIONS) {
      const ordered = Array.from(this.sessions.entries()).sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      for (let i = 0; i < ordered.length - MAX_SESSIONS; i++) this.sessions.delete(ordered[i][0])
    }
  }
}
