import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseExportQuery, filterEvents, toCsv, toJsonl, readAuditEvents, eventTime } from '../../src/dashboard/eventExport.js'
import type { BlockEvent } from '../../src/types.js'

// #592: export events (prompt blocks, MCP logging, everything the Events tab
// shows) to a file, filtered by time and kind.
const ev = (id: string, timestamp: string, extra: Partial<BlockEvent> = {}): BlockEvent => ({
  id, timestamp, stage: 'heuristic', score: 60, similarity: 0, target: 'api.anthropic.com', method: 'POST', path: '/v1/messages',
  payload_preview: 'preview', payload_full: 'full', action: 'blocked', ...extra,
}) as BlockEvent

const EVENTS = [
  ev('a', '2026-10-30 10:00:00Z', { kind: 'prompt' }),
  ev('b', '2026-10-31 12:00:00Z', { kind: 'mcp', mcpTool: 'Bash', action: 'warned' }),
  ev('c', '2026-11-01 08:30:00Z', { kind: 'classifier' }),
]

describe('the export query', () => {
  it('reads since, until, kinds and the format', () => {
    const q = parseExportQuery(new URLSearchParams('since=2026-10-31&until=2026-11-01T00:00:00Z&kind=mcp,prompt&format=csv'))
    expect(q).toEqual({ since: Date.parse('2026-10-31'), until: Date.parse('2026-11-01T00:00:00Z'), kinds: new Set(['mcp', 'prompt']), format: 'csv' })
    expect(parseExportQuery(new URLSearchParams(''))).toEqual({ format: 'jsonl' })
  })

  it('refuses a date it cannot read, an unknown format, or a range that ends before it starts', () => {
    expect(parseExportQuery(new URLSearchParams('since=yesterday'))).toEqual({ error: expect.stringContaining('since') })
    expect(parseExportQuery(new URLSearchParams('format=xlsx'))).toEqual({ error: expect.stringContaining('format') })
    expect(parseExportQuery(new URLSearchParams('since=2026-11-02&until=2026-11-01'))).toEqual({ error: expect.stringContaining('before') })
  })
})

describe('filtering', () => {
  it('keeps events inside the range, inclusive, and of the asked kinds', () => {
    expect(filterEvents(EVENTS, { format: 'jsonl', since: Date.parse('2026-10-31T00:00:00Z') }).map(e => e.id)).toEqual(['b', 'c'])
    expect(filterEvents(EVENTS, { format: 'jsonl', until: Date.parse('2026-10-31T12:00:00Z') }).map(e => e.id)).toEqual(['a', 'b'])
    expect(filterEvents(EVENTS, { format: 'jsonl', kinds: new Set(['mcp']) }).map(e => e.id)).toEqual(['b'])
    expect(filterEvents(EVENTS, { format: 'jsonl' }).map(e => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('reads the event timestamp format', () => {
    expect(eventTime(EVENTS[0]!)).toBe(Date.parse('2026-10-30T10:00:00Z'))
    expect(Number.isNaN(eventTime(ev('x', 'garbage')))).toBe(true)
  })
})

describe('formats', () => {
  it('writes one JSON event per line', () => {
    const lines = toJsonl(EVENTS.slice(0, 2)).trimEnd().split('\n')
    expect(lines.map(l => JSON.parse(l).id)).toEqual(['a', 'b'])
  })

  it('writes CSV with a header, quoting, and no cell a spreadsheet would run as a formula', () => {
    const csv = toCsv([ev('q', '2026-10-31 12:00:00Z', { payload_preview: '=HYPERLINK("http://evil.example","click")', path: 'a,"b"' }), ev('r', '2026-10-31 12:00:01Z', { payload_preview: '+1-2', target: '@sum(A1)' })])
    const rows = csv.trimEnd().split('\r\n')
    expect(rows[0]).toBe('timestamp,id,action,stage,kind,score,similarity,target,method,path,mcpTool,payload_preview')
    expect(rows[1]).toContain('"a,""b"""')
    expect(rows[1]).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`)
    expect(rows[2]).toContain("'+1-2")
    expect(rows[2]).toContain("'@sum(A1)")
  })
})

describe('reading the audit log', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'llmfw-export-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads the rotated generation first, then the current file, and skips lines that do not parse', async () => {
    const file = join(dir, 'audit.jsonl')
    writeFileSync(`${file}.1`, `${JSON.stringify({ schema: 1, ...EVENTS[0] })}\n`)
    writeFileSync(file, `${JSON.stringify({ schema: 1, ...EVENTS[1] })}\n{"torn":\n${JSON.stringify({ schema: 1, ...EVENTS[2] })}\n`)
    expect((await readAuditEvents(file)).map(e => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns nothing when there is no audit file yet', async () => {
    expect(await readAuditEvents(join(dir, 'missing.jsonl'))).toEqual([])
  })
})
