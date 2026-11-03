// Raising sensitivity for a session that keeps testing the boundary (#540).
//
// A request can pass every cheap stage while the session around it has spent ten
// minutes probing. crescendo.ts reads the conversation; this reads what the
// pipeline has already flagged. Three distinct flagged prompts in ten minutes
// send every later prompt of that session to the judge for thirty, each further
// probe extending it. Opt-in, and the judge must be on: it costs a local model
// call per prompt, and the session is the client's IP, so people behind one
// address share it. All that sharing can cost is more judge calls.
//
// Only prompts count, because the session wrote those. A flagged tool result was
// written by whoever owns the page. Distinct texts only, because an agent resends
// its whole history every turn, and one flagged prompt must not read as many.
// Holds a hash of each text, never the text.

export const PROBES_TO_ESCALATE = 3
export const PROBE_WINDOW_MS = 10 * 60 * 1000
export const ESCALATION_HOLD_MS = 30 * 60 * 1000
const MAX_SESSIONS = 10_000
const MAX_TEXTS_PER_SESSION = PROBES_TO_ESCALATE * 32

interface Session {
  // Text key to when it was first flagged in this window.
  texts: Map<string, number>
  escalatedUntil: number
}

export class ProbeTracker {
  private sessions = new Map<string, Session>()

  /** Record a flagged prompt. True only when this one escalates the session. */
  note(sessionKey: string, textKey: string, now: number = Date.now()): boolean {
    let session = this.sessions.get(sessionKey)
    if (session) {
      // Most recently used last, so eviction takes the longest idle.
      this.sessions.delete(sessionKey)
    } else {
      session = { texts: new Map(), escalatedUntil: 0 }
    }
    this.sessions.set(sessionKey, session)
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) this.sessions.delete(oldest)
    }

    for (const [key, at] of session.texts) if (now - at > PROBE_WINDOW_MS) session.texts.delete(key)
    if (session.texts.has(textKey)) return false
    session.texts.set(textKey, now)
    if (session.texts.size > MAX_TEXTS_PER_SESSION) {
      const oldest = session.texts.keys().next().value
      if (oldest !== undefined) session.texts.delete(oldest)
    }

    const wasEscalated = session.escalatedUntil > now
    if (wasEscalated) {
      session.escalatedUntil = now + ESCALATION_HOLD_MS
      return false
    }
    if (session.texts.size < PROBES_TO_ESCALATE) return false
    session.escalatedUntil = now + ESCALATION_HOLD_MS
    return true
  }

  isEscalated(sessionKey: string, now: number = Date.now()): boolean {
    return (this.sessions.get(sessionKey)?.escalatedUntil ?? 0) > now
  }

  sessionCount(): number {
    return this.sessions.size
  }

  textCount(sessionKey: string): number {
    return this.sessions.get(sessionKey)?.texts.size ?? 0
  }
}
