/**
 * The folder of originals the shunt replaced, and of the outcomes it
 * remembers, under the llm-fw directory. Stub: every method throws until the
 * store is written.
 */

export type StoreResult = 'stored' | 'full' | 'failed' | 'unrestricted'

export type StoredOutcome = { condensed: string } | { whole: string }

export class StoredOriginals {
  constructor(_maxBytes: () => number) {}

  dir(): string {
    throw new Error('StoredOriginals.dir is not implemented')
  }

  pathFor(_text: string): string {
    throw new Error('StoredOriginals.pathFor is not implemented')
  }

  write(_text: string): Promise<StoreResult> {
    return Promise.reject(new Error('StoredOriginals.write is not implemented'))
  }

  touch(_text: string): Promise<boolean> {
    return Promise.reject(new Error('StoredOriginals.touch is not implemented'))
  }

  remove(_text: string): Promise<void> {
    return Promise.reject(new Error('StoredOriginals.remove is not implemented'))
  }

  writeOutcome(_key: string, _outcome: StoredOutcome): Promise<StoreResult> {
    return Promise.reject(new Error('StoredOriginals.writeOutcome is not implemented'))
  }

  readOutcome(_key: string): Promise<StoredOutcome | null> {
    return Promise.reject(new Error('StoredOriginals.readOutcome is not implemented'))
  }

  touchOutcome(_key: string): Promise<boolean> {
    return Promise.reject(new Error('StoredOriginals.touchOutcome is not implemented'))
  }

  sweep(_retentionMs: number): Promise<number> {
    return Promise.reject(new Error('StoredOriginals.sweep is not implemented'))
  }

  purge(): Promise<number> {
    return Promise.reject(new Error('StoredOriginals.purge is not implemented'))
  }

  stats(): { files: number; bytes: number } {
    throw new Error('StoredOriginals.stats is not implemented')
  }

  startSweeping(_retentionMs: () => number, _everyMs?: number): () => void {
    throw new Error('StoredOriginals.startSweeping is not implemented')
  }
}
