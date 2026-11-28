import type { DosConfig } from '../../types.js'
import { QuotaManager } from './quota.js'
import { LoopDetector } from './loopDetector.js'

/** Address sessions held before the least recently seen is dropped. */
const MAX_ADDRESS_SESSIONS = 10_000

/**
 * The cost gates of one session: its request-rate quota, token budget and
 * loop detector.
 */
export interface SessionGates {
  quota: QuotaManager
  loop: LoopDetector
}

/**
 * The cost key of a client address: an IPv6 address by its /64, which one
 * host is usually given whole and can rotate through at will (security
 * review); an IPv4 address as it is.
 */
export function addressCostKey(address: string): string {
  const a = address.replace(/^::ffff:/i, '')
  if (!a.includes(':')) return a
  const zone = a.indexOf('%')
  const bare = zone === -1 ? a : a.slice(0, zone)
  const [head = '', tail = ''] = bare.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = bare.includes('::') ? [...left, ...Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => '0'), ...right] : left
  return groups.slice(0, 4).map(g => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

/**
 * The proxy's cost gates, one set per session (#912). The proxy serves one
 * developer and keeps one set for the process; a gateway serves many clients
 * and tenants, so one process-wide quota would be shared by all of them, and a
 * loop detector keyed on the body alone would read two clients sending the
 * same prompt as one looping agent. The gateway keys a session by tenant when
 * one authenticated, else by client address (an IPv6 address by its /64).
 *
 * Tenant sessions are never dropped: there are as many as tenants are
 * configured. Address sessions are bounded: past MAX_ADDRESS_SESSIONS the
 * least recently seen is dropped with its counts, which frees a quota that a
 * new address would have had anyway. Limits are read from the live config.
 */
export class SessionCostGates {
  private readonly tenants = new Map<string, SessionGates>()
  private readonly addresses = new Map<string, SessionGates>()

  constructor(private readonly config: DosConfig) {}

  private create(): SessionGates {
    return { quota: new QuotaManager(this.config), loop: new LoopDetector() }
  }

  /** The gates of a tenant, created on first use. */
  forTenant(id: string): SessionGates {
    let gates = this.tenants.get(id)
    if (!gates) {
      gates = this.create()
      this.tenants.set(id, gates)
    }
    return gates
  }

  /** The gates of a client address, created on first use. */
  forAddress(address: string): SessionGates {
    const key = addressCostKey(address)
    let gates = this.addresses.get(key)
    if (gates) {
      this.addresses.delete(key)
    } else {
      gates = this.create()
      if (this.addresses.size >= MAX_ADDRESS_SESSIONS) this.addresses.delete(this.addresses.keys().next().value as string)
    }
    this.addresses.set(key, gates)
    return gates
  }

  /** Sessions held, for tests and diagnostics. */
  get size(): number {
    return this.tenants.size + this.addresses.size
  }
}
