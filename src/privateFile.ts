import fs from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write a file only its owner can read (0600), whole: to a temporary file
 * beside it, then renamed over it, so a reader never sees half of it and a
 * crash leaves the old one (#921). For llm-fw's state files that hold what
 * the user would not share: false-positive marks, the proxy settings setup
 * replaced (a proxy URL can carry credentials).
 */
export function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to remove */ }
    throw err
  }
}
