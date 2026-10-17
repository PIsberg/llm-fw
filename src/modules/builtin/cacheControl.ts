import type { CacheControlConfig } from '../../types.js'
import type { GatewayModuleContext, ModuleStats } from '../types.js'
import { PayloadModule, type PayloadOutcome } from '../base.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function hasCacheControl(node: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (Array.isArray(node)) return node.some(n => hasCacheControl(n, depth + 1))
  if (!isObj(node)) return false
  if ('cache_control' in node) return true
  return Object.values(node).some(v => hasCacheControl(v, depth + 1))
}

/**
 * Anthropic prompt caching for clients that do not ask for it. A cached
 * prefix is billed at a fraction of the input price on every later request
 * that repeats it; without a marker nothing is cached. Adds the top-level
 * automatic breakpoint, which follows the end of the conversation turn by
 * turn, and optionally one on the system prompt, so separate conversations
 * that share tools and system prompt share that entry too.
 *
 * A request that places any marker of its own (Claude Code does) is left
 * alone: the client already decided, and the API allows four breakpoints.
 * Saves cost, not tokens: the usage meter shows the cache reads.
 */
export class CacheControlModule extends PayloadModule<CacheControlConfig> {
  readonly id = 'cache-control'
  readonly name = 'Prompt Cache Marker'
  readonly description = 'Turns on Anthropic prompt caching for requests that carry no cache_control of their own'

  private marked = 0
  private clientManaged = 0

  constructor(config?: CacheControlConfig) {
    super(config ?? { enabled: false, ttl: '5m', cacheSystem: true })
  }

  protected apply(payload: Obj, ctx: GatewayModuleContext): PayloadOutcome | null {
    const path = ctx.path.split('?')[0]
    if (ctx.target !== 'api.anthropic.com' || path !== '/v1/messages' || !Array.isArray(payload.messages)) return null
    if (hasCacheControl(payload)) {
      this.clientManaged++
      return null
    }
    const marker = this.cfg.ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
    payload.cache_control = marker
    if (this.cfg.cacheSystem) {
      if (typeof payload.system === 'string' && payload.system !== '') {
        payload.system = [{ type: 'text', text: payload.system, cache_control: { ...marker } }]
      } else if (Array.isArray(payload.system) && payload.system.length > 0) {
        const last: unknown = payload.system[payload.system.length - 1]
        if (isObj(last)) last.cache_control = { ...marker }
      }
    }
    this.marked++
    return { changed: true, tokensOriginal: 0, tokensPruned: 0 }
  }

  getStats(): ModuleStats {
    return {
      ...super.getStats(),
      kpis: [
        { key: 'marked', label: 'Requests marked', value: this.marked },
        { key: 'clientManaged', label: 'Already marked by the client', value: this.clientManaged },
      ],
    }
  }

  resetStats(): void {
    super.resetStats()
    this.marked = 0
    this.clientManaged = 0
  }
}
