import crypto from 'node:crypto'
import type { ModuleEvent, ResponseCacheConfig } from '../../types.js'
import type { GatewayModule, GatewayModuleContext, ModuleResponse, ModuleStats, ModuleTransformResult } from '../types.js'
import type { CapturedResponse } from '../responseTap.js'
import { parseUsage } from '../usage.js'
import { collectTextSlots } from '../payload.js'
import { estimateTokens } from '../tokens.js'

// Request headers that decide whose request it is or shape the answer. The
// credential headers keep one caller from ever being served a response
// fetched with another's key; the version, beta and encoding headers change
// what the provider sends back. Anything else (user agent, request ids,
// retry counters) does not split the cache.
const KEY_HEADERS = [
  'authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'x-llm-fw-key',
  'anthropic-version', 'anthropic-beta', 'openai-beta', 'openai-organization', 'openai-project',
  'accept', 'accept-encoding',
]

// Framing is recomputed for the replayed body.
const DROPPED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive'])

interface Entry {
  response: CapturedResponse
  storedAt: number
  billedTokens: number
}

/**
 * Replays the provider's response to a byte-identical request from the same
 * credential, within a TTL, without contacting the provider. Useful for
 * retries, evaluation reruns and scripted agents that ask the same thing
 * twice; a person who asks again expecting a new answer gets the old one,
 * which is why it is opt-in and the TTL is short.
 */
export class ResponseCacheModule implements GatewayModule {
  readonly id = 'response-cache'
  readonly name = 'Response Cache'
  readonly description = 'Replays the stored response to a byte-identical request from the same credential, within a TTL'

  // The live config object, so hot reload and the dashboard toggle reach it.
  private readonly cfg: ResponseCacheConfig
  private readonly now: () => number
  private entries = new Map<string, Entry>()
  private hits = 0
  private misses = 0
  private tokensSaved = 0
  private recentEvents: ModuleEvent[] = []

  constructor(config?: ResponseCacheConfig, now: () => number = Date.now) {
    this.cfg = config ?? { enabled: false, ttlSeconds: 300, maxEntries: 100, maxEntryBytes: 524_288 }
    this.now = now
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

  private key(requestBody: string, ctx: GatewayModuleContext): string {
    const hash = crypto.createHash('sha256')
    for (const part of [ctx.target, ctx.method, ctx.path, ctx.tenant ?? '']) hash.update(part).update('\0')
    for (const name of KEY_HEADERS) {
      const value = ctx.headers?.[name]
      hash.update(name).update('=').update(Array.isArray(value) ? value.join(', ') : value ?? '').update('\0')
    }
    return hash.update(requestBody).digest('hex')
  }

  respond(requestBody: string, ctx: GatewayModuleContext): ModuleResponse | undefined {
    if (ctx.dryRun) return undefined
    const key = this.key(requestBody, ctx)
    const entry = this.entries.get(key)
    if (!entry || this.now() - entry.storedAt > this.cfg.ttlSeconds * 1000) {
      if (entry) this.entries.delete(key)
      this.misses++
      return undefined
    }
    // Most recently used goes to the back of the eviction order.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits++
    this.tokensSaved += entry.billedTokens
    const event = this.event(ctx, entry.billedTokens)
    return {
      response: { ...entry.response, headers: { ...entry.response.headers, 'x-llm-fw-cache': 'hit' } },
      events: [event],
    }
  }

  observeResponse(requestBody: string, ctx: GatewayModuleContext, response: CapturedResponse): void {
    if (ctx.dryRun || response.status !== 200 || response.body.length > this.cfg.maxEntryBytes) return
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(response.headers)) {
      if (!DROPPED_HEADERS.has(name)) headers[name] = value
    }
    // What a hit saves: the provider's own count when the response carries
    // one, else an estimate over the prompt text.
    const usage = parseUsage(response.body, response.headers)
    let billedTokens = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens : 0
    if (!usage) {
      try {
        billedTokens = collectTextSlots(JSON.parse(requestBody)).reduce((sum, s) => sum + estimateTokens(s.text), 0)
      } catch {
        billedTokens = 0
      }
    }
    const key = this.key(requestBody, ctx)
    this.entries.delete(key)
    this.entries.set(key, { response: { status: 200, headers, body: response.body }, storedAt: this.now(), billedTokens })
    while (this.entries.size > Math.max(0, this.cfg.maxEntries)) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  private event(ctx: GatewayModuleContext, saved: number): ModuleEvent {
    const event: ModuleEvent = {
      id: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      moduleId: this.id,
      moduleName: this.name,
      target: ctx.target,
      path: ctx.path,
      tokensOriginal: saved,
      tokensPruned: 0,
      tokensSaved: saved,
      percentSaved: saved > 0 ? 100 : 0,
      totalTokensSaved: this.tokensSaved,
      overallPercentSaved: 100,
      applied: true,
    }
    this.recentEvents.unshift(event)
    if (this.recentEvents.length > 50) this.recentEvents.pop()
    return event
  }

  getStats(): ModuleStats {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      totalInvocations: this.hits,
      tokensOriginal: this.tokensSaved,
      tokensPruned: 0,
      tokensSaved: this.tokensSaved,
      percentSaved: this.tokensSaved > 0 ? 100 : 0,
      recentEvents: [...this.recentEvents],
      kpis: [
        { key: 'hits', label: 'Hits', value: this.hits },
        { key: 'misses', label: 'Misses', value: this.misses },
        { key: 'entries', label: 'Stored responses', value: this.entries.size },
        { key: 'saved', label: 'Billed tokens avoided', value: this.tokensSaved },
      ],
    }
  }

  resetStats(): void {
    this.hits = 0
    this.misses = 0
    this.tokensSaved = 0
    this.recentEvents = []
  }
}
