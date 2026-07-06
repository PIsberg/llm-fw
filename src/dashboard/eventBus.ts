import { BlockEvent, DashboardConfig, TrafficMetric, WhitelistEntry } from '../types.js'
import { randomUUID } from 'node:crypto'
import { ServerResponse } from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { getLlmFwDir } from '../config/paths.js'
import { MetricsRegistry } from './metrics.js'

export class EventBus {
  private ring: BlockEvent[] = []
  private maxSize: number
  private subscribers: ServerResponse[] = []
  private trafficRing: TrafficMetric[] = []
  private trafficSubscribers: ServerResponse[] = []
  private static readonly TRAFFIC_MAX = 500
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
  constructor(config: DashboardConfig, private metrics?: MetricsRegistry) { this.maxSize = config.maxEvents }

  emit(partial: Omit<BlockEvent, 'id' | 'timestamp'>): BlockEvent {
    const event: BlockEvent = {
      ...partial,
      id: randomUUID(),
      timestamp: new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium' }).format() + 'Z',
    }
    this.ring.push(event)
    if (this.ring.length > this.maxSize) this.ring.shift()
    const data = 'data: ' + JSON.stringify(event) + '\n\n'
    this.subscribers = this.subscribers.filter(r => !r.writableEnded && !r.destroyed)
    for (const res of this.subscribers) res.write(data)
    this.metrics?.recordEvent(event)
    return event
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' })
    this.subscribers.push(res)
    for (const event of this.ring) res.write('data: ' + JSON.stringify(event) + '\n\n')
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
    const data = 'data: ' + JSON.stringify(metric) + '\n\n'
    this.trafficSubscribers = this.trafficSubscribers.filter(r => !r.writableEnded && !r.destroyed)
    for (const res of this.trafficSubscribers) res.write(data)
    return metric
  }

  subscribeTraffic(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' })
    this.trafficSubscribers.push(res)
    for (const m of this.trafficRing) res.write('data: ' + JSON.stringify(m) + '\n\n')
    res.on('close', () => { this.trafficSubscribers = this.trafficSubscribers.filter(r => r !== res) })
  }

  getTrafficMetrics(limit: number): TrafficMetric[] {
    return [...this.trafficRing].reverse().slice(0, limit)
  }

  getRecent(limit: number, page: number): BlockEvent[] {
    const all = [...this.ring].reverse()
    return all.slice(page * limit, page * limit + limit)
  }

  getAll(): BlockEvent[] { return [...this.ring].reverse() }

  /**
   * Mark a buffered event as a false positive and persist it to
   * ~/.llm-fw/whitelist.json so the decision survives restarts. The event must
   * still be in the in-memory ring (it is referenced by id). Returns the stored
   * entry, or null if no event with that id is currently buffered.
   */
  whitelist(id: string, reason?: string): WhitelistEntry | null {
    const event = this.ring.find(e => e.id === id)
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
      whitelistedAt: new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium' }).format() + 'Z',
      reason,
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
