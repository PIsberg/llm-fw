// `llm-fw fp`: triage a false positive from the command line (#811).
//
// The steps were five hand-written curl calls against the dashboard API, and
// the first one printed payload_preview, which starts with the blocked text.
// An agent behind this firewall that ran it had its own output withheld, on the
// step meant to decide whether the block was wrong. Nothing this command prints
// holds the blocked text: the listing comes from /api/events/triage, and
// `check` reads the text locally and prints only counts and yes or no.
//
// Recording always comes first and always needs a reason, because a reason
// written down is what a later `npm run fpr` or an issue can be built from.
// Unblocking is a mark on one text (POST /api/feedback): it moves no threshold.
import fs from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { loadConfig } from '../config/config.js'
import type { TriageRow } from '../dashboard/triage.js'
import type { BlockEvent } from '../types.js'

const ACTIONS = ['list', 'check', 'record', 'unblock', 'undo'] as const
type Action = typeof ACTIONS[number]

interface Dashboard {
  host: string
  port: number
  token?: string
}

interface Reply {
  status: number
  body: unknown
}

const WILDCARD = new Set(['0.0.0.0', '::', '[::]', ''])

async function dashboard(): Promise<Dashboard> {
  const config = await loadConfig()
  const bind = config.dashboard.bindHost ?? '127.0.0.1'
  // A wildcard bind listens on loopback too, where no token is needed.
  const host = WILDCARD.has(bind) ? '127.0.0.1' : bind.replace(/^\[|\]$/g, '')
  return { host, port: config.dashboard.port, ...(config.dashboard.authToken ? { token: config.dashboard.authToken } : {}) }
}

// node:http rather than fetch: setup persists HTTPS_PROXY, and a fetch that
// honours it would send this request through the proxy it is asking about.
function call(d: Dashboard, method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (d.token) headers.Authorization = `Bearer ${d.token}`
    const req = http.request({ host: d.host, port: d.port, method, path, headers, timeout: 10_000 }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        let parsed: unknown = data
        try { parsed = JSON.parse(data) } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('timeout', () => req.destroy(new Error('the dashboard did not answer within 10 s')))
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

function errorOf(reply: Reply): string {
  const b = reply.body as { error?: unknown } | undefined
  return typeof b?.error === 'string' ? b.error : `HTTP ${reply.status}`
}

function valuesOf(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!)
  return out
}

function positionals(args: string[]): string[] {
  const valued = new Set(['--limit', '--in', '--contains', '--reason'])
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (valued.has(a)) { i++; continue }
    if (!a.startsWith('-')) out.push(a)
  }
  return out
}

function fail(message: string): void {
  console.error(message)
  process.exitCode = 1
}

const time = (iso: string): string => iso.slice(11, 19)

/** One line per event; every field is an identifier, a number or a flag. */
export function formatRows(rows: TriageRow[]): string {
  if (rows.length === 0) return 'No blocked events held. Events live in memory: a restart forgets them.'
  const lines = rows.map(r => {
    const state = [r.marked ? 'marked' : '', r.recorded ? 'recorded' : '', r.withheld ? 'withheld' : '', r.enforced === false ? 'observed' : '', r.markable ? '' : 'not-markable']
      .filter(Boolean).join(',') || '-'
    return [r.id, `${time(r.timestamp)}Z`, r.rule, r.surface ?? '-', `${r.length} chars`, state].join('  ')
  })
  return lines.join('\n')
}

/** Non-blank lines, trimmed: what a file and a tool result are compared on. */
function textLines(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.stryker-tmp'])
const MAX_FILE_BYTES = 4 * 1024 * 1024

function* filesUnder(path: string): Generator<string> {
  let stat: fs.Stats
  try { stat = fs.statSync(path) } catch { return }
  if (stat.isFile()) {
    if (stat.size <= MAX_FILE_BYTES) yield path
    return
  }
  if (!stat.isDirectory()) return
  for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    yield* filesUnder(join(path, entry.name))
  }
}

export interface SourceMatch {
  path: string
  found: number
  total: number
  /** For a directory, the one file holding the most of the lines. */
  best?: { path: string; found: number }
}

/** How many of the text's lines appear, trimmed, somewhere in `path`. */
export function matchSource(text: string, path: string): SourceMatch {
  const wanted = new Set(textLines(text))
  const seen = new Set<string>()
  let best: { path: string; found: number } | undefined
  for (const file of filesUnder(path)) {
    let content: string
    try { content = fs.readFileSync(file, 'utf8') } catch { continue }
    if (content.includes('\x00')) continue
    let here = 0
    for (const line of new Set(textLines(content))) {
      if (!wanted.has(line)) continue
      here++
      seen.add(line)
    }
    if (here > 0 && (!best || here > best.found)) best = { path: file, found: here }
  }
  const isDir = (() => { try { return fs.statSync(path).isDirectory() } catch { return false } })()
  return { path, found: seen.size, total: wanted.size, ...(isDir && best ? { best } : {}) }
}

async function findEvent(d: Dashboard, id: string): Promise<BlockEvent | undefined> {
  for (let page = 0; ; page++) {
    const reply = await call(d, 'GET', `/api/events?limit=500&page=${page}`)
    if (reply.status !== 200 || !Array.isArray(reply.body)) throw new Error(`GET /api/events: ${errorOf(reply)}`)
    const events = reply.body as BlockEvent[]
    const hit = events.find(e => e.id === id)
    if (hit) return hit
    if (events.length < 500) return undefined
  }
}

const NOT_HELD = 'Events live in memory only: a restart forgets them, and llm-fw keeps the last dashboard.maxEvents blocked ones. Re-run the command that was blocked and use the new event.'

async function list(d: Dashboard, args: string[]): Promise<void> {
  const limit = valuesOf(args, '--limit')[0]
  const query = new URLSearchParams()
  if (limit) query.set('limit', limit)
  if (args.includes('--all')) query.set('all', '1')
  const qs = query.toString()
  const path = qs ? '/api/events/triage?' + qs : '/api/events/triage'
  const reply = await call(d, 'GET', path)
  if (reply.status !== 200 || !Array.isArray(reply.body)) return fail(`llm-fw fp: ${errorOf(reply)}`)
  const rows = reply.body as TriageRow[]
  console.log(args.includes('--json') ? JSON.stringify(rows, null, 2) : formatRows(rows))
}

async function check(d: Dashboard, id: string, args: string[]): Promise<void> {
  const event = await findEvent(d, id)
  if (!event) return fail(`llm-fw fp: no event ${id}. ${NOT_HELD}`)
  const text = event.payload_full || event.payload_preview || ''
  console.log(`${event.id}  ${event.action}  stage ${event.stage}  ${textLines(text).length} lines, ${text.length} chars`)
  const sources = valuesOf(args, '--in')
  const needles = valuesOf(args, '--contains')
  if (sources.length === 0 && needles.length === 0) {
    console.log('Nothing to check: give --in <file or directory> to compare its lines, or --contains <text> to test for a string you expect.')
    return
  }
  for (const [i, needle] of needles.entries()) console.log(`contains #${i + 1}: ${text.includes(needle) ? 'yes' : 'no'}`)
  for (const source of sources) {
    if (!fs.existsSync(source)) { console.log(`${source}: does not exist`); continue }
    const m = matchSource(text, source)
    const where = m.best ? ` (most in ${m.best.path}: ${m.best.found})` : ''
    console.log(`${source}: ${m.found} of ${m.total} lines found${where}`)
  }
}

async function record(d: Dashboard, id: string, reason: string): Promise<boolean> {
  const reply = await call(d, 'POST', '/api/whitelist', { id, reason })
  if (reply.status === 404) { fail(`llm-fw fp: no event ${id}. ${NOT_HELD}`); return false }
  if (reply.status !== 200) { fail(`llm-fw fp: recording failed: ${errorOf(reply)}`); return false }
  console.log(`Recorded ${id} in whitelist.json with your reason. This changes no verdict.`)
  return true
}

async function unblock(d: Dashboard, id: string, reason: string): Promise<void> {
  if (!await record(d, id, reason)) return
  const reply = await call(d, 'POST', '/api/feedback', { eventId: id })
  if (reply.status !== 200) return fail(`llm-fw fp: not marked: ${errorOf(reply)}. It stays recorded.`)
  const hash = (reply.body as { entry?: { hash?: string } }).entry?.hash ?? ''
  console.log('Marked as a false positive: the same text on the same surface now warns instead of blocking, and so do near copies.')
  console.log('Rerun the identical command: a changed line range or width is a different text.')
  console.log(`Undo: llm-fw fp undo ${hash}`)
}

async function undo(d: Dashboard, hash: string): Promise<void> {
  const reply = await call(d, 'DELETE', `/api/suppressions?hash=${encodeURIComponent(hash)}`, {})
  if (reply.status !== 200) return fail(`llm-fw fp: ${errorOf(reply)}`)
  console.log(`Removed the mark ${hash}.`)
}

export async function run(args: string[]): Promise<void> {
  const [first, second] = positionals(args)
  const action = (first ?? 'list') as Action
  if (!ACTIONS.includes(action)) return fail(`llm-fw fp: unknown action "${first}". Use one of: ${ACTIONS.join(', ')}.`)
  if (action !== 'list' && !second) return fail(`llm-fw fp ${action}: needs ${action === 'undo' ? 'the hash a mark printed' : 'an event id, from llm-fw fp list'}.`)
  const reason = valuesOf(args, '--reason')[0]?.trim()
  if ((action === 'record' || action === 'unblock') && !reason) {
    return fail(`llm-fw fp ${action}: --reason is required: say which file, lines or command produced the text and why it is benign.`)
  }
  const d = await dashboard()
  try {
    switch (action) {
      case 'list': return await list(d, args)
      case 'check': return await check(d, second!, args)
      case 'record': { await record(d, second!, reason!); return }
      case 'unblock': return await unblock(d, second!, reason!)
      case 'undo': return await undo(d, second!)
    }
  } catch (err) {
    fail(`llm-fw fp: cannot reach the dashboard at http://${d.host}:${d.port} (${(err as Error).message}). Is llm-fw running? Try llm-fw status.`)
  }
}
