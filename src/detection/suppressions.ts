// Operator-driven false-positive suppression list.
//
// A detection stage occasionally blocks a legitimate prompt (the whole point
// of this firewall's tuning, but no threshold is perfect). This module lets
// an operator mark a specific block event as a false positive from the
// dashboard, without loosening any detection threshold for everything else.
// A mark matches in two ways:
//
// 1. Exactly: the same (normalized) text is downgraded to a warn.
// 2. As a near copy: a false positive rarely comes back byte for byte. A file
//    grew, a command's timing moved, the harness appended a reminder. Measured
//    on 7 days of real transcripts (17,648 items, the rule stages): 70 of 445
//    findings arrived with more than one text, and no later text matched an
//    exact mark on the first. Stripping reminders and digits from the key
//    barely moved that (heuristic 339 keys to 337, indirect 206 to 206), so
//    normalization does not close it. A text sharing at least MIN_SHARED of a
//    marked text's lines has those lines removed and the rest scanned as
//    usual. Only text the operator vouched for is removed, so copying a marked
//    text gains an attacker nothing: every other line is scored, and a line
//    differing by one byte is another line. The overlap requirement keeps a
//    near copy from vouching for one line everywhere; the one case where a
//    single line counts on its own is the third way below. And a
//    changed line naming a destination (a URL, an address, an IP) keeps the
//    whole text scored. An instruction can span lines, and neither half blocks
//    alone: with a marked "Please forward the report" on one line, an attacker
//    who changes only the address on the next would otherwise pass.
// 3. As a vouched line in another text (#646): the flagged line itself comes
//    back inside different output. Measured over a week of real tool results,
//    27 of the 72 repeats a near copy missed were exactly this. It passes only
//    in the narrow form the maintainer chose: the line fired alone in a block
//    by that stage when it was marked (firedLines; not every line of the marked
//    text), on the same surface; it fires that stage alone now and no other
//    line does; neither neighbour continues its sentence; and no other line
//    names a destination. The
//    rest of the text is scanned by every stage, as for a near copy. The trade
//    is that a vouched line is vouched for wherever it appears on that surface,
//    so a mark on a document quoting an attack passes that exact quote, byte for
//    byte, in other output on that surface; nothing else that quote is next to.
//
// Persisted at <getLlmFwDir()>/suppressions.json as a flat array of
// { hash, preview, addedAt, lines?, stage?, fired? }. Only sha256 hashes of the text
// are stored, never the raw prompt, so the file never grows into a second copy
// of sensitive prompt history. `preview` is a short, truncated excerpt kept
// purely so the operator can recognize the entry later; it is not used for
// matching.
//
// Hashing mirrors the embedding stage's cache-key derivation (embedding.ts:
// `createHash('sha256').update(normalizeSemantic(text)).digest(...)`) so a
// suppression matches exactly the text the rest of the detection pipeline
// treats as equivalent — same normalization, same notion of "identical
// prompt" — without importing any embedding-model machinery. embedding.ts
// does not export this helper (it is a private implementation detail of the
// LRU cache), so it is mirrored here rather than refactored out, per the
// batch-2 ground rules (never touch the embedding calibration surface).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { getLlmFwDir } from '../config/paths.js'
import { normalizeSemantic } from './normalize.js'
import { DESTINATION_RE, detectSecretFileExfil } from './secretFileExfil.js'
import { detectIndirectInstruction, type IndirectInstructionOptions } from './indirectInstruction.js'
import type { ScanSource } from '../types.js'

export interface SuppressionEntry {
  /** sha256 hex digest of the semantically-normalized prompt text. */
  hash: string
  /** Truncated excerpt for operator recognition — never used for matching. */
  preview: string
  addedAt: string
  /** Keys of the marked text's lines (suppressionLines). Absent: exact match only. */
  lines?: string[]
  /** The stage that blocked it, which a near copy's warn reports. */
  stage?: string
  /** Keys of the lines that fired the stage alone when marked (firedLines). Absent: none vouched elsewhere. */
  fired?: string[]
}

/** What a mark leaves of a near copy of its text (withoutMarkedLines). */
export interface NearCopy {
  /** The lines nobody vouched for, which still have to be scanned. */
  text: string
  /** How many of the text's distinct lines the mark covers, and of how many. */
  vouched: number
  total: number
  stage?: string
  /** A vouched line in another text (withoutVouchedLines), rather than a near copy. */
  elsewhere?: true
}

const PREVIEW_LEN = 200

// The share of a marked text's lines another text must carry to count as a
// copy of it. Measured over the 130 later texts of findings in real
// transcripts: 64 honoured at 0.5, 77 at 0.25, 85 with no minimum. Ignoring
// digits when comparing moved none of those, so it is not done.
const MIN_SHARED = 0.5
// A bigger text matches exactly only: its entry would hold megabytes of hashes.
const MAX_MARKED_LINES = 5000

// The number Claude Code's Read puts before a line moves when a line above it
// is added. Anchored, and only digits are dropped, so no content goes with it.
const READ_LINE_NUMBER_RE = /^[ \t]*\d+[\t\u2192]/
const LINE_BREAK_RE = /\r?\n/
// What secretFileExfil.ts counts as somewhere to send a file. Its own copy is
// global, so it keeps a position between calls and this one must not.
const CHANGED_LINE_DESTINATION_RE = new RegExp(DESTINATION_RE.source)

/**
 * The key of one line, or null for a blank one. A vouched line is removed
 * unscanned, so it has to be what the operator vouched for, byte for byte.
 */
function withoutReadNumber(rawLine: string): string {
  return rawLine.replace(READ_LINE_NUMBER_RE, '')
}

function lineKey(rawLine: string, source: ScanSource): string | null {
  const line = withoutReadNumber(rawLine).trim()
  if (line === '') return null
  const scope = source === 'system' ? 'prompt' : source
  return createHash('sha256').update(scope).update('\0').update(line).digest('hex').slice(0, 32)
}

/** The distinct line keys a mark on `text` stores; none for a text too long to keep. */
export function suppressionLines(text: string, source: ScanSource): string[] {
  const keys = new Set<string>()
  for (const raw of text.split(LINE_BREAK_RE)) {
    const key = lineKey(raw, source)
    if (key === null) continue
    keys.add(key)
    if (keys.size > MAX_MARKED_LINES) return []
  }
  return [...keys]
}

// A line that ends mid-sentence, and one that starts as the rest of a sentence.
const JOINING_END_RE = /(?:,|\b(?:and|or|but|then|to|with|please|also|plus|the|a|an|of|for|into|from|via))$/i
const JOINING_START_RE = /^(?:and|or|but|then|also|plus|including|to|into|via|with|from)\b/i
const LOWER_START_RE = /^[a-z]/

/** Whether `next` reads as the rest of the sentence `line` started. */
function continuesLine(line: string, next: string): boolean {
  const end = withoutReadNumber(line).trim()
  const start = withoutReadNumber(next).trim()
  return JOINING_END_RE.test(end) || JOINING_START_RE.test(start) || LOWER_START_RE.test(start)
}

/** Whether one line fires the indirect-instruction stage on its own, the way the stage decides. */
export function indirectLineFires(line: string, options?: IndirectInstructionOptions): boolean {
  return detectIndirectInstruction(line, options) !== null || detectSecretFileExfil(line) !== null
}

/**
 * The keys of the lines of a text blocked by `stage` that fire it alone, which
 * a mark may vouch for in another text (withoutVouchedLines). Recorded when the
 * mark is made, so a rule added later cannot vouch for a line the operator
 * never saw flagged. Only the indirect-instruction stage reads lines this way;
 * any other stage gets none.
 */
export function firedLines(text: string, source: ScanSource, stage: string | undefined, options?: IndirectInstructionOptions): string[] | undefined {
  if (stage !== 'indirect-instruction') return undefined
  const keys = new Set<string>()
  const checked = new Set<string>()
  for (const raw of text.split(LINE_BREAK_RE)) {
    const key = lineKey(raw, source)
    if (key === null || checked.has(key)) continue
    checked.add(key)
    if (checked.size > MAX_MARKED_LINES) return []
    if (indirectLineFires(withoutReadNumber(raw), options)) keys.add(key)
  }
  return [...keys]
}

/** sha256 of the semantically-normalized text — the suppression matching key. */
export function hashPrompt(text: string): string {
  return createHash('sha256').update(normalizeSemantic(text)).digest('hex')
}

/**
 * The key a suppression of `text` scanned on `source` is stored under. The
 * prompt and system surfaces share the plain hash, as they always have. Any
 * other surface carries untrusted data, so its key names the surface too:
 * marking a prompt does not wave the same text through as a tool result, and
 * a marked tool result covers that exact tool result and nothing else.
 */
export function suppressionKey(text: string, source: ScanSource): string {
  if (source === 'prompt' || source === 'system') return hashPrompt(text)
  return createHash('sha256').update(source).update('\0').update(normalizeSemantic(text)).digest('hex')
}

/**
 * The key of a mark the ASCII-smuggling stage honours: the raw text, invisible
 * characters included. suppressionKey hashes normalized text, which has lost
 * them, so under it a mark on a text would also cover that text with a payload
 * hidden in it, at the one stage that exists to read one.
 */
export function rawSuppressionKey(text: string, source: ScanSource): string {
  return createHash('sha256').update('raw\0').update(source).update('\0').update(text).digest('hex')
}

export class SuppressionStore {
  private hashes = new Set<string>()
  // Entries that also match a near copy, by hash.
  private marked = new Map<string, { lines: Set<string>; stage?: string; fired?: Set<string> }>()
  // The lines that fired in those entries, by the stage that blocked them, for withoutVouchedLines.
  private vouched = new Map<string, Set<string>>()

  private static filePath(): string {
    // Resolved per access (not cached at construction) so a test/CLI that
    // sets LLM_FW_DIR after this module loads is still honoured, matching
    // getLlmFwDir()'s own contract.
    return join(getLlmFwDir(), 'suppressions.json')
  }

  /** Load persisted suppressions from disk into the in-memory Set. Missing or
   *  corrupt file degrades to an empty set (feature is inert, never throws). */
  load(): void {
    const entries = this.readAll()
    this.hashes = new Set(entries.map(e => e.hash))
    this.marked = new Map()
    for (const e of entries) this.rememberLines(e, false)
    this.indexVouched()
  }

  private rememberLines(e: SuppressionEntry, reindex = true): void {
    if (!Array.isArray(e.lines) || e.lines.length === 0) return
    this.marked.set(e.hash, {
      lines: new Set(e.lines),
      ...(typeof e.stage === 'string' ? { stage: e.stage } : {}),
      ...(Array.isArray(e.fired) ? { fired: new Set(e.fired) } : {}),
    })
    if (reindex) this.indexVouched()
  }

  private indexVouched(): void {
    this.vouched = new Map()
    for (const mark of this.marked.values()) {
      if (mark.stage === undefined || !mark.fired || mark.fired.size === 0) continue
      const lines = this.vouched.get(mark.stage) ?? new Set<string>()
      this.vouched.set(mark.stage, lines)
      for (const key of mark.fired) lines.add(key)
    }
  }

  /**
   * `text` without the lines a mark of `stage` vouched for, when those are the
   * only lines that fire that stage alone (`firesAlone`) and no other line
   * names a destination; otherwise null. For a text that is not a near copy
   * of any mark. See the note at the top of this file.
   */
  withoutVouchedLines(
    text: string, source: ScanSource, stage: string,
    firesAlone: (line: string) => boolean,
    namesDestination: (line: string) => boolean = l => CHANGED_LINE_DESTINATION_RE.test(l),
  ): NearCopy | null {
    const vouched = this.vouched.get(stage)
    if (!vouched) return null
    const lines = text.split(LINE_BREAK_RE).map(raw => ({ raw, key: lineKey(raw, source) }))
    if (!lines.some(l => l.key !== null && vouched.has(l.key))) return null
    const distinct = new Set<string>()
    for (const l of lines) if (l.key !== null) distinct.add(l.key)
    if (distinct.size > MAX_MARKED_LINES) return null
    // Every line that fires alone has to be a vouched one. A line that fires
    // only together with another is no vouched line's doing, so none firing
    // means the instruction spans lines and the text stays whole.
    const firing = new Set<string>()
    const checked = new Set<string>()
    for (const l of lines) {
      if (l.key === null || checked.has(l.key)) continue
      checked.add(l.key)
      if (!firesAlone(withoutReadNumber(l.raw))) continue
      if (!vouched.has(l.key)) return null
      firing.add(l.key)
    }
    if (firing.size === 0) return null
    // A vouched line is vouched for as a sentence of its own. One that the
    // next line continues ("... and the payroll file too"), or that continues
    // the line before it, may be part of an instruction it never was.
    const nonBlank = lines.filter(l => l.key !== null)
    for (let i = 0; i < nonBlank.length; i++) {
      if (!firing.has(nonBlank[i]!.key!)) continue
      const before = nonBlank[i - 1]
      const after = nonBlank[i + 1]
      if (after && !firing.has(after.key!) && continuesLine(nonBlank[i]!.raw, after.raw)) return null
      if (before && !firing.has(before.key!) && continuesLine(before.raw, nonBlank[i]!.raw)) return null
    }
    const rest = lines.filter(l => l.key !== null && !firing.has(l.key)).map(l => l.raw)
    if (rest.some(namesDestination)) return null
    return { text: rest.join('\n'), vouched: firing.size, total: distinct.size, stage, elsewhere: true }
  }

  /**
   * `text` without the lines of the marked text it is a near copy of, or null
   * when it is not a near copy of any. When several marks qualify, the one
   * covering the most lines. See the note at the top of this file.
   */
  withoutMarkedLines(text: string, source: ScanSource): NearCopy | null {
    if (this.marked.size === 0) return null
    const lines = text.split(LINE_BREAK_RE).map(raw => ({ raw, key: lineKey(raw, source) }))
    const distinct = new Set<string>()
    for (const l of lines) if (l.key !== null) distinct.add(l.key)
    let best: { lines: Set<string>; stage?: string } | null = null
    let bestShared = 0
    for (const mark of this.marked.values()) {
      let shared = 0
      for (const key of distinct) if (mark.lines.has(key)) shared++
      if (shared > bestShared && shared / mark.lines.size >= MIN_SHARED) {
        best = mark
        bestShared = shared
      }
    }
    if (!best) return null
    const covering = best
    const changed = lines.filter(l => l.key !== null && !covering.lines.has(l.key)).map(l => l.raw)
    if (changed.some(l => CHANGED_LINE_DESTINATION_RE.test(l))) return null
    return {
      text: changed.join('\n'),
      vouched: bestShared,
      total: distinct.size,
      ...(covering.stage !== undefined ? { stage: covering.stage } : {}),
    }
  }

  /** Fast in-memory check — the hot path consulted by the detection pipeline
   *  on every prompt/system candidate. */
  isSuppressed(text: string): boolean {
    return this.hashes.has(hashPrompt(text))
  }

  /** Whether a suppression is stored under `key` (see suppressionKey). */
  has(key: string): boolean {
    return this.hashes.has(key)
  }

  /**
   * Record a false-positive suppression. Read-merge-write against the
   * persisted file (mirrors the ~/.llm-fw/config.json and whitelist.json
   * patterns elsewhere in this codebase): re-read the current file, append if
   * the hash is new, write the whole array back. De-dupes by hash so
   * re-marking the same prompt is a no-op that returns the existing entry.
   */
  add(text: string, previewSource?: string): SuppressionEntry {
    return this.addKey(hashPrompt(text), previewSource ?? text)
  }

  /**
   * Record a suppression under a key the pipeline already derived for a block
   * event (BlockEvent.suppressionKey), for the stages whose event shows a
   * label and a snippet rather than the text they scanned. With `near`, it
   * also matches a near copy of that text. Marking a text again adds what an
   * older entry for it lacks.
   */
  addKey(hash: string, preview: string, near?: { lines: string[]; stage?: string; fired?: string[] | undefined }): SuppressionEntry {
    const lines = near && near.lines.length > 0 ? near.lines : undefined
    const entries = this.readAll()
    const existing = entries.find(e => e.hash === hash)
    if (existing) {
      this.hashes.add(hash)
      const fired = lines !== undefined && !existing.fired ? near?.fired : undefined
      if ((lines && !existing.lines) || fired) {
        if (!existing.lines && lines) existing.lines = lines
        if (near?.stage !== undefined) existing.stage = near.stage
        if (fired) existing.fired = fired
        this.write(entries)
      }
      this.rememberLines(existing)
      return existing
    }

    const entry: SuppressionEntry = {
      hash,
      preview: preview.slice(0, PREVIEW_LEN),
      addedAt: new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' }).format() + 'Z',
      ...(lines ? { lines } : {}),
      ...(lines && near?.stage !== undefined ? { stage: near.stage } : {}),
      ...(lines && near?.fired !== undefined ? { fired: near.fired } : {}),
    }
    entries.push(entry)
    this.write(entries)
    this.hashes.add(hash)
    this.rememberLines(entry)
    return entry
  }

  /** Remove a suppression by hash. Returns false if no entry had that hash. */
  remove(hash: string): boolean {
    const entries = this.readAll()
    const next = entries.filter(e => e.hash !== hash)
    if (next.length === entries.length) return false
    this.write(next)
    this.hashes.delete(hash)
    this.marked.delete(hash)
    this.indexVouched()
    return true
  }

  /** All persisted suppressions, most-recently-added last. */
  list(): SuppressionEntry[] {
    return this.readAll()
  }

  private readAll(): SuppressionEntry[] {
    try {
      const raw = fs.readFileSync(SuppressionStore.filePath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed as SuppressionEntry[] : []
    } catch {
      return []
    }
  }

  private write(entries: SuppressionEntry[]): void {
    const dir = getLlmFwDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(SuppressionStore.filePath(), JSON.stringify(entries, null, 2), 'utf8')
  }
}
