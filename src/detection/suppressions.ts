// Operator-driven false-positive suppression list.
//
// A detection stage occasionally blocks a legitimate prompt (the whole point
// of this firewall's tuning, but no threshold is perfect). This module lets
// an operator mark a specific block event as a false positive from the
// dashboard; the exact (normalized) prompt text is then remembered so an
// IDENTICAL future prompt is downgraded to a warn instead of blocked again —
// without loosening any detection threshold for everything else.
//
// Persisted at <getLlmFwDir()>/suppressions.json as a flat array of
// { hash, preview, addedAt }. Only the sha256 hash of the NORMALIZED text is
// stored — never the raw prompt — so the file stays small and never grows
// into a second copy of sensitive prompt history. `preview` is a short,
// truncated excerpt kept purely so the operator can recognize the entry
// later; it is not used for matching.
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

export interface SuppressionEntry {
  /** sha256 hex digest of the semantically-normalized prompt text. */
  hash: string
  /** Truncated excerpt for operator recognition — never used for matching. */
  preview: string
  addedAt: string
}

const PREVIEW_LEN = 200

/** sha256 of the semantically-normalized text — the suppression matching key. */
export function hashPrompt(text: string): string {
  return createHash('sha256').update(normalizeSemantic(text)).digest('hex')
}

export class SuppressionStore {
  private hashes = new Set<string>()

  private static filePath(): string {
    // Resolved per access (not cached at construction) so a test/CLI that
    // sets LLM_FW_DIR after this module loads is still honoured, matching
    // getLlmFwDir()'s own contract.
    return join(getLlmFwDir(), 'suppressions.json')
  }

  /** Load persisted suppressions from disk into the in-memory Set. Missing or
   *  corrupt file degrades to an empty set (feature is inert, never throws). */
  load(): void {
    this.hashes = new Set(this.readAll().map(e => e.hash))
  }

  /** Fast in-memory check — the hot path consulted by the detection pipeline
   *  on every prompt/system candidate. */
  isSuppressed(text: string): boolean {
    return this.hashes.has(hashPrompt(text))
  }

  /**
   * Record a false-positive suppression. Read-merge-write against the
   * persisted file (mirrors the ~/.llm-fw/config.json and whitelist.json
   * patterns elsewhere in this codebase): re-read the current file, append if
   * the hash is new, write the whole array back. De-dupes by hash so
   * re-marking the same prompt is a no-op that returns the existing entry.
   */
  add(text: string, previewSource?: string): SuppressionEntry {
    const hash = hashPrompt(text)
    const entries = this.readAll()
    const existing = entries.find(e => e.hash === hash)
    if (existing) {
      this.hashes.add(hash)
      return existing
    }

    const entry: SuppressionEntry = {
      hash,
      preview: (previewSource ?? text).slice(0, PREVIEW_LEN),
      addedAt: new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium' }).format() + 'Z',
    }
    entries.push(entry)
    this.write(entries)
    this.hashes.add(hash)
    return entry
  }

  /** Remove a suppression by hash. Returns false if no entry had that hash. */
  remove(hash: string): boolean {
    const entries = this.readAll()
    const next = entries.filter(e => e.hash !== hash)
    if (next.length === entries.length) return false
    this.write(next)
    this.hashes.delete(hash)
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
