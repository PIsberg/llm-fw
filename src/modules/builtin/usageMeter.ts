import fs from 'node:fs'
import { dirname } from 'node:path'
import type { GatewayModule, GatewayModuleContext, ModuleAction, ModuleTransformResult, ModuleStats } from '../types.js'
import type { CacheControlConfig, ModuleSwitchConfig } from '../../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { parseUsage, type Usage } from '../usage.js'
import { parsePayload } from '../base.js'
import { collectTextSlots } from '../payload.js'
import { estimateTokens } from '../tokens.js'
import { createLogger } from '../../logger.js'

const log = createLogger('usage-meter')

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// Cache entries by client (#746). A one-hour cache entry costs 2 times the
// input price to write and a five-minute one 1.25; a cache read costs 0.1.
// So five-minute entries save 0.75 per token written, and cost 1.15 per token
// a call would have read after five idle minutes, when it has to write them
// again instead. After an hour both lifetimes have expired.
const IDLE_MS = 5 * 60_000
const HOUR_MS = 60 * 60_000
const SAVED_PER_WRITE = 0.75
const LOST_PER_READ = 1.15
// Conversations of a client seen before the card offers it to the Prompt
// Cache Marker, and how many times its saving must cover its cost.
const MIN_CONVERSATIONS = 50
const MARGIN = 4
// Bounds on what one process remembers, oldest conversation evicted first.
const MAX_SESSIONS = 5000
const MAX_CLIENTS = 50
// How many clients the card lists.
const CLIENT_LIMIT = 20
// Coalesce writes: one per this many ms while traffic flows.
const SAVE_DELAY_MS = 5000
// A name that may go into a config list: a User-Agent is whatever the client
// says, so anything else is not reported.
const SAFE_NAME = /^[A-Za-z0-9._-]{1,60}$/

/** What the meter knows about one client's cache entries. */
interface ClientTotals {
  /** What names the client in shortTtlClients: Claude Code's mode, else the product. */
  token: string
  conversations: number
  /** Conversations with at least one gap of five minutes or more between calls. */
  idled: number
  /** Tokens written with a one-hour lifetime. */
  write1h: number
  /** Tokens read from the cache by calls that followed 5 to 60 idle minutes. */
  readAfterGap: number
  /** Those calls. */
  gaps: number
}

// The client a User-Agent names, as [label, token]: Claude Code says how it
// runs in brackets (`claude-cli/2.1.321 (external, sdk-cli)`), and print
// mode idles differently from an interactive session, so the mode is part
// of the label and is what shortTtlClients matches. Any other client is its
// product name.
function clientOf(agent: string): [string, string] | undefined {
  const product = agent.split(/[/\s]/, 1)[0] ?? ''
  if (!SAFE_NAME.test(product)) return undefined
  const open = agent.indexOf('(')
  const close = open < 0 ? -1 : agent.indexOf(')', open)
  const mode = close < 0 ? '' : (agent.slice(open + 1, close).split(',').pop() ?? '').trim()
  if (product === 'claude-cli' && SAFE_NAME.test(mode)) return [`${product} (${mode})`, mode]
  return [product, product]
}

const header = (ctx: GatewayModuleContext, name: string): string => {
  const value = ctx.headers?.[name]
  return (Array.isArray(value) ? value[0] : value) ?? ''
}
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')

// The estimate over a request's text, for comparison with what was billed
// for it; undefined when the request carries no text, or when the server
// holds history the request does not carry (a thread continuation, a
// Responses API request with previous_response_id), which is billed too.
function estimatedText(requestBody: string): number | undefined {
  const payload = parsePayload(requestBody)
  if (!payload) return undefined
  if ((isObj(payload.thread) && payload.thread.type === 'continue') || typeof payload.previous_response_id === 'string') return undefined
  const n = collectTextSlots(payload).reduce((sum, slot) => sum + estimateTokens(slot.text), 0)
  return n > 0 ? n : undefined
}

/**
 * Adds up the token counts the provider reports in each response. The other
 * modules' savings are estimates made before the request leaves; this is the
 * provider's own bill, including the cache reads and writes that decide what
 * a long agent session costs. Reads responses only and changes nothing.
 *
 * It also compares the billed input of each response with the estimate over
 * the request's text (#356): the estimate is fitted to public tokenizers,
 * and Claude's is not public, so the ratio is the only measure of its error
 * on the traffic that passes here.
 *
 * And it keeps, per client, how its conversations use the prompt cache
 * (#746): how many idled five minutes or more, what they wrote at the
 * one-hour price, and what five-minute entries would have changed. That is
 * the evidence for the Prompt Cache Marker's shortTtlClients, which pays for
 * a client that never idles and costs a rewrite each time one does.
 */
export class UsageMeterModule implements GatewayModule {
  readonly id = 'usage-meter'
  readonly name = 'Usage Meter'
  readonly description = 'Adds up the token counts providers report in their responses: uncached input, cache reads and writes, output, and how each client\'s conversations use the prompt cache. Changes nothing.'

  // The live config object, so hot reload and the dashboard toggle reach it.
  private readonly cfg: ModuleSwitchConfig

  private responses = 0
  private input = 0
  private cacheRead = 0
  private cacheWrite = 0
  private output = 0
  // Responses whose request text could be estimated: billed input against
  // the estimate, summed, and how many.
  private comparedBilled = 0
  private comparedEstimated = 0
  private compared = 0

  // Totals per client label, and when each conversation last called, in
  // order of last use.
  private readonly clients = new Map<string, ClientTotals>()
  private readonly sessions = new Map<string, { last: number; idled: boolean }>()
  // The Prompt Cache Marker's live config, read when the card is drawn.
  private readonly cacheControl: (() => CacheControlConfig | undefined) | undefined
  private readonly now: () => number
  // Where the totals per client survive a restart; unset in tests and
  // library use.
  private file: string | undefined
  private saveTimer: NodeJS.Timeout | undefined

  constructor(config?: ModuleSwitchConfig, cacheControl?: () => CacheControlConfig | undefined, now: () => number = Date.now) {
    this.cfg = config ?? { enabled: true }
    this.cacheControl = cacheControl
    this.now = now
  }

  /**
   * Keep the totals per client in `file` across restarts: load what is
   * there, then write changes back at most every SAVE_DELAY_MS. Fifty
   * conversations of a client are days of traffic for some installs. Names
   * and counts only. A missing or unreadable file starts empty.
   */
  persistTo(file: string): void {
    this.file = file
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { clients?: Record<string, Partial<ClientTotals>> }
      for (const [label, c] of Object.entries(saved.clients ?? {}).slice(0, MAX_CLIENTS)) {
        if (typeof c.token !== 'string' || !SAFE_NAME.test(c.token)) continue
        const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
        this.clients.set(label, { token: c.token, conversations: n(c.conversations), idled: n(c.idled), write1h: n(c.write1h), readAfterGap: n(c.readAfterGap), gaps: n(c.gaps) })
      }
    } catch { /* nothing saved yet, or unreadable: start empty */ }
  }

  /** Write the totals per client now, if persisting. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (!this.file) return
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ clients: Object.fromEntries(this.clients) }), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      log.warn('could not save usage by client; it stays in memory', { err })
    }
  }

  private changed(): void {
    if (!this.file || this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
    this.saveTimer.unref()
  }

  // One response of a conversation: Claude Code names the conversation in a
  // header, and a client that names none is not reported.
  private observeClient(ctx: GatewayModuleContext, usage: Usage): void {
    const session = header(ctx, 'x-claude-code-session-id')
    const client = session === '' ? undefined : clientOf(header(ctx, 'user-agent'))
    if (!client || session.length > 200) return
    const [label, token] = client
    let totals = this.clients.get(label)
    if (!totals) {
      if (this.clients.size >= MAX_CLIENTS) return
      totals = { token, conversations: 0, idled: 0, write1h: 0, readAfterGap: 0, gaps: 0 }
      this.clients.set(label, totals)
    }
    const now = this.now()
    const key = `${label}\n${session}`
    const seen = this.sessions.get(key)
    if (seen) {
      // Re-inserted below, so the map stays ordered by last use.
      this.sessions.delete(key)
      const gap = now - seen.last
      if (gap >= IDLE_MS) {
        if (!seen.idled) totals.idled++
        seen.idled = true
        if (gap < HOUR_MS) {
          totals.gaps++
          totals.readAfterGap += usage.cacheReadTokens
        }
      }
    } else {
      totals.conversations++
      if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
    }
    this.sessions.set(key, { last: now, idled: seen?.idled ?? false })
    totals.write1h += usage.cacheWrite1hTokens ?? 0
    this.changed()
  }

  // Whether the Prompt Cache Marker is shortening this client's entries: it
  // has to be switched on, a name left in its list does nothing otherwise.
  private named(label: string): boolean {
    const marker = this.cacheControl?.()
    const names = marker?.enabled ? marker.shortTtlClients : undefined
    const lower = label.toLowerCase()
    return Array.isArray(names) && names.some(name => typeof name === 'string' && name !== '' && lower.includes(name.toLowerCase()))
  }

  // The card's line about clients, and the one-click for the Prompt Cache
  // Marker: every client not named yet whose conversations were enough and
  // whose saving covers its cost MARGIN times.
  private clientReport(): { detail?: string; action?: ModuleAction } {
    if (this.clients.size === 0) return {}
    const rows = [...this.clients].sort((a, b) => b[1].write1h - a[1].write1h)
    const offer: string[] = []
    let waiting: ClientTotals | undefined
    const lines = rows.slice(0, CLIENT_LIMIT).map(([label, c]) => {
      const start = `${label}: ${fmt(c.conversations)} conversations, ${fmt(c.idled)} idled 5 minutes or more`
      if (this.named(label)) return `${start}, named in shortTtlClients; a call followed 5 idle minutes ${fmt(c.gaps)} times`
      const saved = c.write1h * SAVED_PER_WRITE
      const lost = c.readAfterGap * LOST_PER_READ
      if (c.write1h > 0 && saved >= MARGIN * lost) {
        if (c.conversations >= MIN_CONVERSATIONS) offer.push(c.token)
        else waiting ??= c
      }
      return `${start}, ${fmt(c.write1h)} one-hour cache-write tokens, five-minute entries would have cost ${fmt(Math.abs(saved - lost))} input tokens ${saved >= lost ? 'less' : 'more'}`
    })
    const more = rows.length > CLIENT_LIMIT ? `; and ${rows.length - CLIENT_LIMIT} more` : ''
    const hint = offer.length === 0 && waiting ? ` The Prompt Cache Marker action appears after ${MIN_CONVERSATIONS} conversations (${fmt(waiting.conversations)} so far).` : ''
    const detail = `Cache entries by client: ${lines.join('; ')}${more}.${hint}`
    const marker = this.cacheControl?.()
    if (offer.length === 0 || !marker) return { detail }
    const names = Array.isArray(marker.shortTtlClients) ? marker.shortTtlClients : []
    const add = [...new Set(offer)]
    return {
      detail,
      action: {
        label: `Use five-minute cache entries for ${add.join(', ')}`,
        module: 'cache-control',
        enabled: true,
        // A name already in the list (the marker was off) is not added twice.
        options: { shortTtlClients: [...names, ...add.filter(name => !names.includes(name))] },
      },
    }
  }

  get enabled(): boolean {
    return this.cfg.enabled
  }

  set enabled(value: boolean) {
    this.cfg.enabled = value
  }

  transformRequest(body: string): ModuleTransformResult {
    return { body, modified: false }
  }

  observeResponse(requestBody: string, ctx: GatewayModuleContext, response: CapturedResponse): void {
    const usage = parseUsage(response.body, response.headers)
    if (!usage) return
    this.responses++
    this.input += usage.inputTokens
    this.cacheRead += usage.cacheReadTokens
    this.cacheWrite += usage.cacheWriteTokens
    this.output += usage.outputTokens
    this.observeClient(ctx, usage)
    const estimated = estimatedText(requestBody)
    if (estimated !== undefined) {
      this.compared++
      this.comparedEstimated += estimated
      this.comparedBilled += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }
  }

  getStats(): ModuleStats {
    const allInput = this.input + this.cacheRead + this.cacheWrite
    const ratio = allInput > 0 ? Math.round((this.cacheRead / allInput) * 1000) / 10 : 0
    const { detail, action } = this.clientReport()
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      totalInvocations: this.responses,
      tokensOriginal: 0,
      tokensPruned: 0,
      tokensSaved: 0,
      percentSaved: 0,
      recentEvents: [],
      kpis: [
        { key: 'responses', label: 'Responses metered', value: this.responses },
        { key: 'input', label: 'Uncached input', value: this.input },
        { key: 'cacheRead', label: 'Cache reads', value: this.cacheRead },
        { key: 'cacheWrite', label: 'Cache writes', value: this.cacheWrite },
        { key: 'output', label: 'Output', value: this.output },
        { key: 'cacheRatio', label: 'Input served from cache', value: `${ratio}%` },
        { key: 'estimateRatio', label: 'Billed input per estimated text token', value: this.comparedEstimated > 0 ? (this.comparedBilled / this.comparedEstimated).toFixed(2) : 'n/a' },
        { key: 'compared', label: 'Responses compared', value: this.compared },
      ],
      ...(detail ? { detail } : {}),
      ...(action ? { action } : {}),
    }
  }

  resetStats(): void {
    this.responses = 0
    this.input = 0
    this.cacheRead = 0
    this.cacheWrite = 0
    this.output = 0
    this.comparedBilled = 0
    this.comparedEstimated = 0
    this.compared = 0
    this.clients.clear()
    this.sessions.clear()
    this.changed()
  }
}
