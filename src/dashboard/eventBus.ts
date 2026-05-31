import { BlockEvent, DashboardConfig, TrafficMetric } from '../types.js'
import { randomUUID } from 'node:crypto'
import { ServerResponse } from 'node:http'

export class EventBus {
  private ring: BlockEvent[] = []
  private maxSize: number
  private subscribers: ServerResponse[] = []
  private trafficRing: TrafficMetric[] = []
  private trafficSubscribers: ServerResponse[] = []
  private static readonly TRAFFIC_MAX = 500

  constructor(config: DashboardConfig) { this.maxSize = config.maxEvents }

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
}
