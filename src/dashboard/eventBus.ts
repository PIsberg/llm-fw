import { BlockEvent, DashboardConfig, ModuleEvent, TrafficMetric, WhitelistEntry } from '../types.js'
import { randomUUID } from 'node:crypto'
import { ServerResponse } from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { getLlmFwDir } from '../config/paths.js'
import { MetricsRegistry } from './metrics.js'
import type { AuditSink } from './auditLog.js'

/**
 * "YYYY-MM-DD HH:MM:SSZ" in UTC. Not through Intl: building a formatter was the
 * slowest step of an event, and a refused request emits one.
 */
function utcStamp(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ') + 'Z'
}

export class EventBus {
  private ring: BlockEvent[] = []
  // Blocked events kept apart from the ring, so the passed/warned traffic an
  // agent session emits by the dozen cannot evict the false positive an
  // operator is about to mark (/api/feedback). Same bound as the ring.
  private blocked = new Map<string, BlockEvent>()
  private maxSize: number
  private subscribers: ServerResponse[] = []
  private trafficRing: TrafficMetric[] = []
  private trafficSubscribers: ServerResponse[] = []
  private moduleEvents: ModuleEvent[] = []
  private static readonly TRAFFIC_MAX = 500
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  // #862: subscribers per stream, and how far one may fall behind before it
  // is let go. A tab that stopped reading kept every event in its socket's
  // buffer, and nothing bounded how many tabs or scripts subscribed.
  static readonly MAX_SUBSCRIBERS = 64
  private static readonly MAX_BUFFERED_BYTES = 1024 * 1024
  // Persisted store of events an operator marked as false positives.
  // Resolved per access so LLM_FW_DIR set after module load is honoured.
  private static get WHITELIST_PATH(): string {
    return join(getLlmFwDir(), 'whitelist.json')
  }

  // Task C4 — optional shared metrics registry. Populated from the SAME hook
  // every dashboard block/warn/audit event already funnels through (this
  // emit() method), so /metrics stays consistent with what the Live Traffic
  // / Events UI shows without a second wiring pass through every scanner in
  // proxy.ts. Optional so every existing call site (tests, scripts) that
  // doesn't care about metrics is unaffected.
  // Durable sinks. Optional, and attached to emit() for the same reason the
  // metrics registry is: this is the one place every block, warn and audit
  // event already passes through, so nothing can be recorded on the dashboard
  // and missing from the audit trail.
  private auditLog?: AuditSink | undefined
  private auditWebhook?: AuditSink | undefined

  /**
   * Attach the durable audit sinks. Separate from the constructor so the many
   * existing call sites (tests, scripts, the playground pipeline) keep working
   * unchanged and simply never write an audit record.
   */
  setAuditSinks(log?: AuditSink, webhook?: AuditSink): void {
    this.auditLog = log
    this.auditWebhook = webhook
  }

  constructor(config: DashboardConfig, private metrics?: MetricsRegistry) {
    this.maxSize = config.maxEvents
    // Send SSE comment heartbeats every 15s to keep browser/proxy connections alive.
    // Without this, many browsers and reverse-proxies close idle SSE sockets after 30-60s.
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 15_000)
    // A long-lived dashboard process should not be pinned in memory by the timer alone.
    this.heartbeatTimer.unref?.()
  }

  private sendHeartbeat(): void {
    this.subscribers = EventBus.fanOut(this.subscribers, ':\n\n')
    this.trafficSubscribers = EventBus.fanOut(this.trafficSubscribers, ':\n\n')
  }

  /**
   * Write `data` to every live subscriber and return the ones still worth
   * writing to (#862). A write that throws, or a subscriber with more than
   * MAX_BUFFERED_BYTES unsent, is let go and its socket closed; nothing a
   * subscriber does can stop the caller from going on to the metrics and the
   * audit sinks.
   */
  private static fanOut(subscribers: ServerResponse[], data: string): ServerResponse[] {
    const kept: ServerResponse[] = []
    for (const res of subscribers) {
      if (res.writableEnded || res.destroyed) continue
      if (res.writableLength > EventBus.MAX_BUFFERED_BYTES) { EventBus.drop(res); continue }
      try {
        res.write(data)
        kept.push(res)
      } catch {
        EventBus.drop(res)
      }
    }
    return kept
  }

  private static drop(res: ServerResponse): void {
    try { res.destroy() } catch { /* already gone */ }
  }

  /** Whether another subscriber fits; answers 503 when not. */
  private static admit(subscribers: ServerResponse[], res: ServerResponse): boolean {
    if (subscribers.filter(r => !r.writableEnded && !r.destroyed).length < EventBus.MAX_SUBSCRIBERS) return true
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' })
    res.end(JSON.stringify({ error: `too many event stream subscribers (${EventBus.MAX_SUBSCRIBERS})` }))
    return false
  }

  /** Stop the heartbeat timer (call during server shutdown). */
  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  emit(partial: Omit<BlockEvent, 'id' | 'timestamp'>): BlockEvent {
    const event: BlockEvent = {
      ...partial,
      id: randomUUID(),
      timestamp: utcStamp(),
    }
    this.ring.push(event)
    if (this.ring.length > this.maxSize) this.ring.shift()
    if (event.action === 'blocked') {
      this.blocked.set(event.id, event)
      if (this.blocked.size > this.maxSize) this.blocked.delete(this.blocked.keys().next().value!)
    }
    this.subscribers = EventBus.fanOut(this.subscribers, 'data: ' + JSON.stringify(event) + '\n\n')
    this.metrics?.recordEvent(event)
    // After the in-memory fan-out, never before: a slow or broken audit sink
    // must not delay the dashboard stream or the request that produced this
    // event. Both sinks swallow their own failures for the same reason.
    this.auditLog?.write(event)
    this.auditWebhook?.write(event)
    return event
  }

  emitModuleEvent(event: ModuleEvent): ModuleEvent {
    this.moduleEvents.push(event)
    if (this.moduleEvents.length > this.maxSize) this.moduleEvents.shift()
    this.subscribers = EventBus.fanOut(this.subscribers, 'event: module\ndata: ' + JSON.stringify(event) + '\n\n')
    return event
  }

  getRecentModuleEvents(limit = 50): ModuleEvent[] {
    return this.moduleEvents.slice(-limit)
  }

  subscribe(res: ServerResponse): void {
    if (!EventBus.admit(this.subscribers, res)) return
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' })
    this.subscribers.push(res)
    for (const event of this.listed()) res.write('data: ' + JSON.stringify(event) + '\n\n')
    for (const me of this.moduleEvents) res.write('event: module\ndata: ' + JSON.stringify(me) + '\n\n')
    res.on('close', () => { this.subscribers = this.subscribers.filter(r => r !== res) })
  }

  emitTraffic(partial: Omit<TrafficMetric, 'id' | 'timestamp'>): TrafficMetric {
    const metric: TrafficMetric = {
      ...partial,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    }
    this.trafficRing.push(metric)
    if (this.trafficRing.length > EventBus.TRAFFIC_MAX) this.trafficRing.shift()
    this.trafficSubscribers = EventBus.fanOut(this.trafficSubscribers, 'data: ' + JSON.stringify(metric) + '\n\n')
    return metric
  }

  subscribeTraffic(res: ServerResponse): void {
    if (!EventBus.admit(this.trafficSubscribers, res)) return
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' })
    this.trafficSubscribers.push(res)
    for (const m of this.trafficRing) res.write('data: ' + JSON.stringify(m) + '\n\n')
    res.on('close', () => { this.trafficSubscribers = this.trafficSubscribers.filter(r => r !== res) })
  }

  getTrafficMetrics(limit: number): TrafficMetric[] {
    return [...this.trafficRing].reverse().slice(0, limit)
  }

  /**
   * The ring, preceded by the blocked events it has already evicted, oldest
   * first. The ring is first in, first out, so an evicted event is older than
   * everything still in it. An agent session emits passed and warned events by
   * the hundred an hour, so a block, or a would-block under observe, left the
   * list in about 15 minutes while the bus still held it (#488).
   */
  private listed(): BlockEvent[] {
    const inRing = new Set(this.ring.map(e => e.id))
    return [...[...this.blocked.values()].filter(e => !inRing.has(e.id)), ...this.ring]
  }

  getRecent(limit: number, page: number): BlockEvent[] {
    const all = this.listed().reverse()
    return all.slice(page * limit, page * limit + limit)
  }

  getAll(): BlockEvent[] { return this.listed().reverse() }

  /** An event by id: any buffered event, or one of the last maxEvents blocked ones. */
  find(id: string): BlockEvent | undefined {
    return this.blocked.get(id) ?? this.ring.find(e => e.id === id)
  }

  /**
   * Mark a buffered event as a false positive and persist it to
   * ~/.llm-fw/whitelist.json so the decision survives restarts. The event must
   * still be in the in-memory ring (it is referenced by id). Returns the stored
   * entry, or null if no event with that id is currently buffered.
   */
  whitelist(id: string, reason?: string): WhitelistEntry | null {
    const event = this.find(id)
    if (!event) return null

    const entries = this.readWhitelist()
    // De-dupe by the underlying payload so re-clicking the same event is a no-op.
    const existing = entries.find(e => e.payload === event.payload_full)
    if (existing) return existing

    const entry: WhitelistEntry = {
      id: event.id,
      payload: event.payload_full,
      stage: event.stage,
      target: event.target,
      whitelistedAt: utcStamp(),
      reason,
      surface: event.suppressionSource,
    }
    entries.push(entry)

    fs.mkdirSync(getLlmFwDir(), { recursive: true })
    fs.writeFileSync(EventBus.WHITELIST_PATH, JSON.stringify(entries, null, 2))
    return entry
  }

  /** Read the persisted whitelist, returning [] if the file is absent or corrupt. */
  readWhitelist(): WhitelistEntry[] {
    try {
      const raw = fs.readFileSync(EventBus.WHITELIST_PATH, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed as WhitelistEntry[] : []
    } catch {
      return []
    }
  }
}
