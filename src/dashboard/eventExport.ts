/**
 * Export of the event stream to a file, filtered by time and kind (#592):
 * `GET /api/events/export?since=&until=&kind=&format=jsonl|csv`.
 *
 * The source is the audit log when it is on (`audit.enabled`: every event
 * since it was switched on, its one rotated generation included), otherwise
 * the dashboard's in-memory buffer (the last `dashboard.maxEvents`). Payloads
 * follow the source: the audit log holds them only with
 * `audit.includePayloads`, the buffer always, as the Events tab shows them.
 *
 * Event text is attacker-controlled. CSV cells that a spreadsheet would run as
 * a formula (a leading =, +, -, @, tab or carriage return) are prefixed with a
 * quote, so an exported prompt cannot become a live formula in Excel.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { BlockEvent } from '../types.js'

export interface ExportQuery {
  since?: number
  until?: number
  kinds?: Set<string>
  format: 'jsonl' | 'csv'
}

function readTime(name: string, raw: string | null): number | undefined | { error: string } {
  if (raw === null || raw === '') return undefined
  const t = Date.parse(raw)
  return Number.isNaN(t) ? { error: `${name}: not a date or time (ISO 8601, e.g. 2026-11-01 or 2026-11-01T08:00:00Z)` } : t
}

/** The export parameters, or the first reason they cannot be used. */
export function parseExportQuery(params: URLSearchParams): ExportQuery | { error: string } {
  const since = readTime('since', params.get('since'))
  if (typeof since === 'object') return since
  const until = readTime('until', params.get('until'))
  if (typeof until === 'object') return until
  if (since !== undefined && until !== undefined && until < since) return { error: 'until is before since' }
  const format = params.get('format') ?? 'jsonl'
  if (format !== 'jsonl' && format !== 'csv') return { error: 'format: jsonl or csv' }
  const kind = params.get('kind')
  const kinds = kind ? new Set(kind.split(',').map(k => k.trim()).filter(Boolean)) : undefined
  return { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), ...(kinds?.size ? { kinds } : {}), format }
}

/** Milliseconds of an event's timestamp ("YYYY-MM-DD HH:MM:SSZ"); NaN when unreadable. */
export function eventTime(e: Pick<BlockEvent, 'timestamp'>): number {
  return Date.parse(String(e.timestamp).replace(' ', 'T'))
}

/** Whether an event is inside the range (inclusive) and of the asked kinds. */
export function matchesExport(e: BlockEvent, q: ExportQuery): boolean {
  if (q.since !== undefined || q.until !== undefined) {
    const t = eventTime(e)
    if (Number.isNaN(t)) return false
    if (q.since !== undefined && t < q.since) return false
    if (q.until !== undefined && t > q.until) return false
  }
  return !q.kinds || q.kinds.has(e.kind ?? 'prompt')
}

/** The events inside the range (inclusive) and of the asked kinds, in their order. */
export function filterEvents(events: readonly BlockEvent[], q: ExportQuery): BlockEvent[] {
  return events.filter(e => matchesExport(e, q))
}

export function toJsonl(events: readonly BlockEvent[]): string {
  return events.map(jsonlRow).join('')
}

/** One event as a JSONL line, its line break included. */
export function jsonlRow(e: BlockEvent): string {
  return JSON.stringify(e) + '\n'
}

const CSV_COLUMNS = ['timestamp', 'id', 'action', 'stage', 'kind', 'score', 'similarity', 'target', 'method', 'path', 'mcpTool', 'payload_preview'] as const

function csvCell(value: unknown): string {
  let s = ''
  if (typeof value === 'string') s = value
  else if (typeof value === 'number' || typeof value === 'boolean') s = String(value)
  else if (value !== undefined && value !== null) s = JSON.stringify(value) ?? ''
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(events: readonly BlockEvent[]): string {
  return CSV_HEADER + events.map(csvRow).join('')
}

/** The CSV header row, its line break included. */
export const CSV_HEADER = CSV_COLUMNS.join(',') + '\r\n'

/** One event as a CSV row, its line break included. */
export function csvRow(e: BlockEvent): string {
  return CSV_COLUMNS.map(c => csvCell((e as unknown as Record<string, unknown>)[c])).join(',') + '\r\n'
}

/** One file's events, a line at a time; nothing when the file does not exist. */
async function* fileEvents(file: string): AsyncGenerator<BlockEvent> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line) as BlockEvent & { schema?: number }
        if (rec && typeof rec === 'object' && typeof rec.id === 'string') yield rec
      } catch { /* a torn line while the log is being written */ }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  } finally {
    stream.destroy()
  }
}

/**
 * Events in the audit log, its rotated generation first; lines that do not
 * parse are skipped. Read a line at a time (#862): both generations together
 * are up to 128 MB, and reading them whole held the file, its lines and every
 * parsed event in memory before the first was filtered.
 */
export async function* auditEvents(file: string): AsyncGenerator<BlockEvent> {
  yield* fileEvents(`${file}.1`)
  yield* fileEvents(file)
}
