// `llm-fw feedback-export`: what the operator recorded as a false positive, as
// eval rows (#542), so a local `npm run fpr` shows whether one comes back after a
// ruleset change.
//
// whitelist.json and these rows hold the operator's own traffic. So the default
// path is the gitignored test/eval/data/local/, nothing here commits anything,
// and turning a recurring case into a committed regression stays a human step:
// write a synthetic row of the same shape into benign-realistic.json. Nothing
// here moves a threshold either: grow the corpus, not the thresholds.
//
// A "Mark false positive" holds a hash and a short preview, by design, so it has
// no text to export. Only "Record as false positive" keeps the text.
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getLlmFwDir } from '../config/paths.js'
import type { ScanSource, WhitelistEntry } from '../types.js'

export interface FeedbackRow {
  text: string
  label: 0
  class: 'operator-feedback'
  surface?: 'tool_result' | 'system' | 'tool_definition'
}

// Where the eval harness delivers a row (test/eval/lib/surfaces.ts). It has no
// document or memory surface, and tool_result is the nearest: untrusted data.
function evalSurface(source: ScanSource | undefined): FeedbackRow['surface'] {
  switch (source) {
    case 'tool_result':
    case 'document':
    case 'memory':
      return 'tool_result'
    case 'system':
    case 'tool_definition':
      return source
    default:
      return undefined
  }
}

export function feedbackRows(entries: WhitelistEntry[]): FeedbackRow[] {
  const seen = new Set<string>()
  const rows: FeedbackRow[] = []
  for (const e of entries) {
    const text = e.payload
    if (typeof text !== 'string' || text.trim() === '' || seen.has(text)) continue
    seen.add(text)
    const surface = evalSurface(e.surface)
    rows.push({ text, label: 0, class: 'operator-feedback', ...(surface ? { surface } : {}) })
  }
  return rows
}

function readArray(path: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const IN_CHECKOUT = join('test', 'eval', 'data')

export function run(args: string[]): void {
  const at = args.indexOf('--out')
  if (at !== -1 && (args[at + 1] === undefined || args[at + 1]?.startsWith('--'))) {
    console.error('--out needs a file path.')
    process.exitCode = 1
    return
  }
  const rows = feedbackRows(readArray(join(getLlmFwDir(), 'whitelist.json')) as WhitelistEntry[])
  const marks = readArray(join(getLlmFwDir(), 'suppressions.json')).length
  const unexportable = marks > 0
    ? `\n${marks} marked false positives hold only a hash and a preview, so they are not in this file. "Record as false positive" on an event keeps its text.`
    : ''
  if (rows.length === 0) {
    console.log(`Nothing to export: no event has been recorded as a false positive.${unexportable}`)
    return
  }

  let out = at === -1 ? undefined : args[at + 1]
  if (out === undefined) {
    if (!fs.existsSync(resolve(IN_CHECKOUT))) {
      console.error(`This is not an llm-fw checkout (no ${IN_CHECKOUT}), and these rows are your own traffic. Say where they go with --out <file>.`)
      process.exitCode = 1
      return
    }
    out = join(IN_CHECKOUT, 'local', 'operator-feedback.json')
  }

  const path = resolve(out)
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, `${JSON.stringify({
    _source: 'llm-fw feedback-export: events recorded as false positives on this machine. Private traffic: never commit it.',
    _threat: 'injection',
    rows,
  }, null, 2)}\n`)
  console.log(`Wrote ${rows.length} row${rows.length === 1 ? '' : 's'} to ${path}. They hold your own traffic: keep them out of version control.\nCheck them with: npm run fpr -- --only=operator-feedback${unexportable}`)
}
