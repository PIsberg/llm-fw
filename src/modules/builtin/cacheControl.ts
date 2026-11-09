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

// Takes the one-hour TTL off a breakpoint, which leaves the default five
// minutes; whatever else the marker says (its scope) stays.
function shortenMarker(node: unknown): number {
  if (!isObj(node) || !isObj(node.cache_control) || node.cache_control.ttl !== '1h') return 0
  node.cache_control = Object.fromEntries(Object.entries(node.cache_control).filter(([key]) => key !== 'ttl'))
  return 1
}

// The breakpoints of the conversation itself: the top-level automatic one,
// those on message blocks, and those on the blocks of a tool result. Walks
// only where the API reads a marker, so a tool argument that happens to be
// named cache_control is left as the model wrote it.
function shortenMessageMarkers(payload: Obj): number {
  let n = shortenMarker(payload)
  for (const message of payload.messages as unknown[]) {
    if (!isObj(message) || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      n += shortenMarker(block)
      if (isObj(block) && block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const part of block.content) n += shortenMarker(part)
      }
    }
  }
  return n
}

// The breakpoints of the prefix conversations share: tools and system prompt.
function shortenPrefixMarkers(payload: Obj): number {
  let n = 0
  for (const list of [payload.tools, payload.system]) {
    if (Array.isArray(list)) for (const item of list) n += shortenMarker(item)
  }
  return n
}

function userAgent(ctx: GatewayModuleContext): string {
  const value = ctx.headers?.['user-agent']
  return (Array.isArray(value) ? value.join(' ') : value ?? '').toLowerCase()
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
 *
 * The one exception is a client named in shortTtlClients. Claude Code asks
 * for one-hour entries, written at 2 times the input price where a
 * five-minute entry costs 1.25, and that pays only when a conversation idles
 * longer than five minutes. A run that never does (print mode, a CI job)
 * pays the difference for nothing, so its one-hour breakpoints are changed
 * to five-minute ones: those in the messages, or with shortTtlScope "all"
 * the ones on tools and system prompt too. One-hour breakpoints must come
 * before five-minute ones, which both scopes keep. The model is sent the
 * same text either way.
 */
export class CacheControlModule extends PayloadModule<CacheControlConfig> {
  readonly id = 'cache-control'
  readonly name = 'Prompt Cache Marker'
  readonly description = 'Turns on Anthropic prompt caching for requests that carry no cache_control of their own, and moves the one-hour cache entries of the clients you name to five minutes'

  private marked = 0
  private wouldMark = 0
  private clientManaged = 0
  private shortened = 0
  private wouldShorten = 0
  private shortenedMarkers = 0

  constructor(config?: CacheControlConfig) {
    super(config ?? { enabled: false, ttl: '5m', cacheSystem: true, shortTtlClients: [], shortTtlScope: 'messages' })
  }

  private namesClient(ctx: GatewayModuleContext): boolean {
    const names = Array.isArray(this.cfg.shortTtlClients) ? this.cfg.shortTtlClients : []
    if (names.length === 0) return false
    const agent = userAgent(ctx)
    return agent !== '' && names.some(name => typeof name === 'string' && name !== '' && agent.includes(name.toLowerCase()))
  }

  // Moves a named client's one-hour breakpoints to five minutes; the number
  // of markers changed.
  private shorten(payload: Obj, ctx: GatewayModuleContext): number {
    if (!this.namesClient(ctx)) return 0
    const n = shortenMessageMarkers(payload) + (this.cfg.shortTtlScope === 'all' ? shortenPrefixMarkers(payload) : 0)
    if (n === 0) return 0
    if (ctx.dryRun) this.wouldShorten++
    else {
      this.shortened++
      this.shortenedMarkers += n
    }
    return n
  }

  protected apply(payload: Obj, ctx: GatewayModuleContext): PayloadOutcome | null {
    const path = ctx.path.split('?')[0]
    if (ctx.target !== 'api.anthropic.com' || path !== '/v1/messages' || !Array.isArray(payload.messages)) return null
    if (hasCacheControl(payload)) {
      if (this.shorten(payload, ctx) > 0) return { changed: true, tokensOriginal: 0, tokensPruned: 0 }
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
    if (ctx.dryRun) this.wouldMark++
    else this.marked++
    return { changed: true, tokensOriginal: 0, tokensPruned: 0 }
  }

  getStats(): ModuleStats {
    return {
      ...super.getStats(),
      kpis: [
        { key: 'marked', label: 'Requests marked', value: this.marked },
        { key: 'wouldMark', label: 'Would mark (observe mode)', value: this.wouldMark },
        { key: 'clientManaged', label: 'Already marked by the client', value: this.clientManaged },
        { key: 'shortened', label: 'Requests moved to 5-minute entries', value: this.shortened },
        { key: 'shortenedMarkers', label: 'Breakpoints moved', value: this.shortenedMarkers },
        { key: 'wouldShorten', label: 'Would move (observe mode)', value: this.wouldShorten },
      ],
    }
  }

  resetStats(): void {
    super.resetStats()
    this.marked = 0
    this.wouldMark = 0
    this.clientManaged = 0
    this.shortened = 0
    this.wouldShorten = 0
    this.shortenedMarkers = 0
  }
}
