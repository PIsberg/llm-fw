import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeLlmfwFiles } from '../../src/cli/uninstall.js'

/**
 * `uninstall --keep-model` reported "Removed CA, CRL, mode + pid" while it
 * also deleted config.json (the user's settings) and whitelist.json (events
 * marked "not an attack"), and it said nothing about the files it leaves, so
 * ~/.llm-fw survived an uninstall with no explanation. Found on a live
 * uninstall of a real install, 2026-10-12.
 */
describe('removeLlmfwFiles', () => {
  let dir: string
  let logged: string[]

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'llmfw-uninstall-'))
    logged = []
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const touch = (...names: string[]): void => {
    for (const n of names) fs.writeFileSync(join(dir, n), '{}')
  }

  it('names the settings and the not-an-attack marks it deletes', () => {
    touch('config.json', 'whitelist.json', 'ca.crt', 'ca.key', 'ca.crl')
    removeLlmfwFiles(dir, false)
    const removed = logged.find(l => l.includes('Removed') && l.includes('ca.crt')) ?? ''
    expect(removed).toContain('config.json')
    expect(removed).toContain('whitelist.json')
    expect(fs.existsSync(join(dir, 'config.json'))).toBe(false)
  })

  it('lists only the files that were there', () => {
    touch('ca.crt', 'ca.key')
    removeLlmfwFiles(dir, false)
    expect(logged.join('\n')).not.toContain('whitelist.json')
  })

  it('says which files it left behind, and keeps them', () => {
    touch('config.json', 'ca.crt', 'license.key', 'audit.jsonl')
    fs.mkdirSync(join(dir, 'models'))
    removeLlmfwFiles(dir, true)
    const left = logged.find(l => l.includes('Left in')) ?? ''
    expect(left).toContain('license.key')
    expect(left).toContain('audit.jsonl')
    expect(left).toContain('models')
    expect(fs.existsSync(join(dir, 'license.key'))).toBe(true)
    expect(fs.existsSync(join(dir, 'models'))).toBe(true)
  })

  it('removes the directory when nothing is left in it', () => {
    touch('config.json', 'ca.crt')
    removeLlmfwFiles(dir, false)
    expect(fs.existsSync(dir)).toBe(false)
    expect(logged.join('\n')).not.toContain('Left in')
  })
})
