import type { DosConfig } from '../../types.js'
import { QuotaManager } from './quota.js'
import { LoopDetector } from './loopDetector.js'

/** Sessions held before the least recently seen is dropped. */
const MAX_SESSIONS = 10_000

/**
 * The cost gates of one session: its request-rate quota, token budget and
 * loop detector.
 */
export interface SessionGates {
  quota: QuotaManager
  loop: LoopDetector
}

/**
 * The proxy's cost gates, one set per session (#912). The proxy serves one
 * developer and keeps one set for the process; a gateway serves many clients
 * and tenants, so one process-wide quota would be shared by all of them, and a
 * loop detector keyed on the body alone would read two clients sending the
 * same prompt as one looping agent. The gateway keys a session by tenant when
 * one authenticated, else by client address.
 *
 * Bounded: past MAX_SESSIONS the least recently seen session is dropped, and
 * with it its counts. Limits are read from the live config.
 */
export class SessionCostGates {
  private readonly sessions = new Map<string, SessionGates>()

  constructor(private readonly config: DosConfig) {}

  /** The gates of this session, created on first use. */
  for(key: string): SessionGates {
    let gates = this.sessions.get(key)
    if (gates) {
      this.sessions.delete(key)
    } else {
      gates = { quota: new QuotaManager(this.config), loop: new LoopDetector() }
      if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string)
    }
    this.sessions.set(key, gates)
    return gates
  }

  /** Sessions held, for tests and diagnostics. */
  get size(): number {
    return this.sessions.size
  }
}
