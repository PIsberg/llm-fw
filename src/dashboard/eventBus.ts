import { BlockEvent, DashboardConfig } from '../types.js'
import { randomUUID } from 'node:crypto'
import { ServerResponse } from 'node:http'

export class EventBus {
  private ring: BlockEvent[] = []
  private maxSize: number
  private subscribers: ServerResponse[] = []

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

  getRecent(limit: number, page: number): BlockEvent[] {
    const all = [...this.ring].reverse()
    return all.slice(page * limit, page * limit + limit)
  }

  getAll(): BlockEvent[] { return [...this.ring].reverse() }
}
