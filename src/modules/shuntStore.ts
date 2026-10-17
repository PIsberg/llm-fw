import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { getLlmFwDir } from '../config/paths.js'
import { restrictDirPermissions } from '../proxy/certs.js'

/**
 * The folder of originals the shunt replaced, and of the outcomes it
 * remembers, under the llm-fw directory. Files are `<sha256 of the text>.txt`
 * and `<key>.outcome`; the name reveals nothing of the content, and nothing
 * here logs a path, a hash or a text.
 *
 * Every operation that changes the folder runs one after another, so the cap
 * check and the write it guards cannot interleave with another write.
 */

/**
 * `stored`: it is on disk. `full`: it would take the folder past the cap, and
 * nothing was deleted to make room. `failed`: the write did not complete and
 * left nothing behind. `unrestricted`: access to the folder cannot be limited
 * to the running user, so nothing was written.
 */
export type StoreResult = 'stored' | 'full' | 'failed' | 'unrestricted'

export type StoredOutcome = { condensed: string } | { whole: string }

const FOLDER = 'tool-results'
const ORIGINAL = '.txt'
const OUTCOME = '.outcome'
/** What a sweep may delete: this module's files and the temp files of an interrupted write. */
const OURS = /\.(?:txt|outcome|tmp)$/
/** A key becomes part of a file name, so it is not trusted to carry a path. */
const KEY = /^[A-Za-z0-9_-]{1,128}$/
const DEFAULT_SWEEP_MS = 30 * 60_000

interface Entry {
  name: string
  file: boolean
  size: number
  mtimeMs: number
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

export class StoredOriginals {
  private tail: Promise<unknown> = Promise.resolve()
  /** The folder `sizes` describes: the totals are rebuilt when the llm-fw directory changes. */
  private loaded: string | null = null
  private readonly sizes = new Map<string, number>()
  private bytes = 0
  /** Folders whose access this instance has already limited to the running user. */
  private readonly restricted = new Set<string>()

  constructor(private readonly maxBytes: () => number) {}

  /** The folder, resolved at each call so a changed `LLM_FW_DIR` is followed. */
  dir(): string {
    return join(getLlmFwDir(), FOLDER)
  }

  pathFor(text: string): string {
    return join(this.dir(), `${sha256(text)}${ORIGINAL}`)
  }

  /** Store the exact text. Storing text that is already there is `stored` and starts a new retention period. */
  write(text: string): Promise<StoreResult> {
    return this.put(`${sha256(text)}${ORIGINAL}`, Buffer.from(text, 'utf8'), true)
  }

  /** Remember an outcome under `key`, replacing an earlier one. */
  writeOutcome(key: string, outcome: StoredOutcome): Promise<StoreResult> {
    if (!KEY.test(key)) return Promise.resolve('failed')
    return this.put(`${key}${OUTCOME}`, Buffer.from(JSON.stringify(outcome), 'utf8'), false)
  }

  /** The outcome under `key`, or null for a missing file or one that is not exactly one of the two shapes. */
  async readOutcome(key: string): Promise<StoredOutcome | null> {
    // Without a named account the folder's access cannot be confirmed, so nothing in it is believed.
    if (!KEY.test(key) || !this.canRestrict()) return null
    try {
      const value: unknown = JSON.parse(await fs.promises.readFile(join(this.dir(), `${key}${OUTCOME}`), 'utf8'))
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
      const keys = Object.keys(value)
      const entry = (value as Record<string, unknown>)[keys[0] ?? '']
      if (keys.length !== 1 || typeof entry !== 'string') return null
      if (keys[0] === 'condensed') return { condensed: entry }
      if (keys[0] === 'whole') return { whole: entry }
      return null
    } catch {
      return null
    }
  }

  /** Start a new retention period for the stored original; false when it is not there. */
  touch(text: string): Promise<boolean> {
    return this.touchFile(this.pathFor(text))
  }

  /** Start a new retention period for an outcome; false when it is not there. */
  touchOutcome(key: string): Promise<boolean> {
    return KEY.test(key) ? this.touchFile(join(this.dir(), `${key}${OUTCOME}`)) : Promise.resolve(false)
  }

  /** Delete the stored original. The outcome file stays. */
  remove(text: string): Promise<void> {
    const name = `${sha256(text)}${ORIGINAL}`
    return this.serial(async () => {
      const dir = this.dir()
      await this.load(dir)
      try {
        await fs.promises.unlink(join(dir, name))
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') return
      }
      this.dropSize(name)
    })
  }

  /**
   * Delete every file nothing carried for longer than `retentionMs` (by
   * mtime), temp files of an interrupted write included, and rebuild the
   * totals from the folder. Returns how many it deleted.
   */
  sweep(retentionMs: number): Promise<number> {
    return this.serial(async () => {
      const dir = this.dir()
      const entries = await this.scan(dir)
      this.reset(dir, entries)
      const cutoff = Date.now() - retentionMs
      let deleted = 0
      for (const entry of entries) {
        if (!entry.file || !OURS.test(entry.name) || entry.mtimeMs >= cutoff) continue
        if (await this.unlinkEntry(dir, entry.name)) deleted++
      }
      return deleted
    })
  }

  /** Delete every file in the folder. Returns how many. */
  purge(): Promise<number> {
    return this.serial(async () => {
      const dir = this.dir()
      const entries = await this.scan(dir)
      this.reset(dir, entries)
      let deleted = 0
      for (const entry of entries) {
        if (entry.file && await this.unlinkEntry(dir, entry.name)) deleted++
      }
      return deleted
    })
  }

  /** Stored originals and bytes of every file, as of the last scan and the writes since. */
  stats(): { files: number; bytes: number } {
    if (this.loaded !== this.dir()) return { files: 0, bytes: 0 }
    let files = 0
    for (const name of this.sizes.keys()) if (name.endsWith(ORIGINAL)) files++
    return { files, bytes: this.bytes }
  }

  /**
   * Sweep now and then every `everyMs` (30 minutes by default), reading the
   * retention at each sweep so the operator can change it live. The timer does
   * not keep the process alive. Returns the function that stops it.
   */
  startSweeping(retentionMs: () => number, everyMs: number = DEFAULT_SWEEP_MS): () => void {
    const tick = (): void => {
      Promise.resolve().then(() => this.sweep(retentionMs())).catch(() => undefined)
    }
    tick()
    const timer = setInterval(tick, everyMs)
    timer.unref()
    return () => clearInterval(timer)
  }

  private canRestrict(): boolean {
    // restrictDirPermissions returns silently on Windows without a USERNAME, leaving the default ACLs.
    return process.platform !== 'win32' || Boolean(process.env.USERNAME)
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private put(name: string, data: Buffer, reuse: boolean): Promise<StoreResult> {
    if (!this.canRestrict()) return Promise.resolve('unrestricted')
    return this.serial(async () => {
      try {
        const dir = this.dir()
        await this.load(dir)
        const path = join(dir, name)
        const existing = await fs.promises.lstat(path).catch(() => null)
        // Only a regular file is an earlier copy: a directory at the path is not.
        const known = existing?.isFile() ? existing.size : 0
        if (existing?.isFile()) this.setSize(name, existing.size)
        if (reuse && existing?.isFile() && known === data.length) {
          const now = new Date()
          await fs.promises.utimes(path, now, now).catch(() => undefined)
          return 'stored'
        }
        if (this.bytes - known + data.length > this.maxBytes()) return 'full'

        const prepared = await this.prepare(dir)
        if (prepared !== 'ready') return prepared
        const temp = join(dir, `${name.slice(0, name.lastIndexOf('.'))}.${randomBytes(4).toString('hex')}.tmp`)
        try {
          await fs.promises.writeFile(temp, data, { flag: 'wx', mode: 0o600 })
          await fs.promises.rename(temp, path)
        } catch {
          await fs.promises.rm(temp, { force: true }).catch(() => undefined)
          return 'failed'
        }
        this.setSize(name, data.length)
        return 'stored'
      } catch {
        return 'failed'
      }
    })
  }

  /** Create the folder if needed and limit it to the running user, once per folder. */
  private async prepare(dir: string): Promise<'ready' | 'failed' | 'unrestricted'> {
    let created: string | undefined
    try {
      created = await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    } catch {
      return 'failed'
    }
    // A folder made again after someone deleted it starts with default access.
    if (created !== undefined || !this.restricted.has(dir)) {
      try {
        restrictDirPermissions(dir)
      } catch {
        return 'unrestricted'
      }
      this.restricted.add(dir)
    }
    return 'ready'
  }

  private async touchFile(path: string): Promise<boolean> {
    if (!this.canRestrict()) return false
    try {
      if (!(await fs.promises.lstat(path)).isFile()) return false
      const now = new Date()
      await fs.promises.utimes(path, now, now)
      return true
    } catch {
      return false
    }
  }

  private async unlinkEntry(dir: string, name: string): Promise<boolean> {
    try {
      await fs.promises.unlink(join(dir, name))
    } catch (error) {
      // Gone already: not ours to count, and no longer in the folder.
      if (codeOf(error) === 'ENOENT') this.dropSize(name)
      return false
    }
    this.dropSize(name)
    return true
  }

  /** Know what is in `dir`, scanning on first use and whenever the llm-fw directory changes. */
  private async load(dir: string): Promise<void> {
    if (this.loaded !== dir) this.reset(dir, await this.scan(dir))
  }

  private reset(dir: string, entries: readonly Entry[]): void {
    this.sizes.clear()
    this.bytes = 0
    for (const entry of entries) if (entry.file) this.setSize(entry.name, entry.size)
    this.loaded = dir
  }

  private async scan(dir: string): Promise<Entry[]> {
    let names: string[]
    try {
      names = await fs.promises.readdir(dir)
    } catch (error) {
      if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') return []
      throw error
    }
    const entries = await Promise.all(names.map(async (name): Promise<Entry | null> => {
      try {
        const stat = await fs.promises.lstat(join(dir, name))
        return { name, file: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs }
      } catch {
        return null // gone since the listing
      }
    }))
    return entries.filter((entry): entry is Entry => entry !== null)
  }

  private setSize(name: string, size: number): void {
    this.bytes += size - (this.sizes.get(name) ?? 0)
    this.sizes.set(name, size)
  }

  private dropSize(name: string): void {
    this.bytes -= this.sizes.get(name) ?? 0
    this.sizes.delete(name)
  }
}
