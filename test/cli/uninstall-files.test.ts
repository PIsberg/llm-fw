import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeLlmfwFiles, noteProjectConfig } from '../../src/cli/uninstall.js'

/**
 * What `uninstall` deletes from ~/.llm-fw (#322).
 *
 * It used to delete config.json (hand-tuned settings) and whitelist.json even
 * with --keep-model, while keeping suppressions.json: the two false-positive
 * stores were treated oppositely, and a reinstall lost every setting. The
 * policy now:
 *
 * - always removed: what makes this machine intercept traffic (the CA, the
 *   pid and runtime state) and the `proxy.mode` key setup wrote, which a
 *   later `start` would otherwise act on by re-arming the sinkhole;
 * - kept: what the user authored (settings, both false-positive stores, the
 *   audit log, the licence), unless --purge;
 * - --purge removes everything llm-fw created except the licence key.
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
  const exists = (n: string): boolean => fs.existsSync(join(dir, n))

  it('removes the interception state and keeps what the user authored', () => {
    touch('ca.crt', 'ca.key', 'ca.crl', 'llm-fw.pid', 'llm-fw.state.json', 'whitelist.json', 'suppressions.json', 'audit.jsonl', 'license.key')
    fs.writeFileSync(join(dir, 'config.json'), JSON.stringify({ proxy: { mode: 'sinkhole' }, detection: { heuristicBlockThreshold: 60 } }))
    removeLlmfwFiles(dir, { keepModel: false, purge: false })

    for (const f of ['ca.crt', 'ca.key', 'ca.crl', 'llm-fw.pid', 'llm-fw.state.json']) expect(exists(f), f).toBe(false)
    for (const f of ['whitelist.json', 'suppressions.json', 'audit.jsonl', 'license.key']) expect(exists(f), f).toBe(true)
    // Settings survive, minus the mode setup chose, so a later start does not
    // touch the hosts file again.
    expect(JSON.parse(fs.readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({ detection: { heuristicBlockThreshold: 60 } })
  })

  it('deletes config.json when the setup mode was all it held', () => {
    fs.writeFileSync(join(dir, 'config.json'), JSON.stringify({ proxy: { mode: 'proxy' } }))
    removeLlmfwFiles(dir, { keepModel: false, purge: false })
    expect(exists('config.json')).toBe(false)
  })

  it('--purge removes the user data too, but never the licence', () => {
    touch('ca.crt', 'config.json', 'whitelist.json', 'suppressions.json', 'audit.jsonl', 'audit.jsonl.1', 'license.key', 'license-offline.lfw')
    fs.mkdirSync(join(dir, 'ocr-cache'))
    removeLlmfwFiles(dir, { keepModel: false, purge: true })
    for (const f of ['config.json', 'whitelist.json', 'suppressions.json', 'audit.jsonl', 'audit.jsonl.1', 'ocr-cache']) expect(exists(f), f).toBe(false)
    expect(exists('license.key')).toBe(true)
    expect(exists('license-offline.lfw')).toBe(true)
  })

  it('names what it removed, with what each file meant', () => {
    touch('ca.crt', 'whitelist.json')
    removeLlmfwFiles(dir, { keepModel: false, purge: true })
    const removed = logged.find(l => l.includes('Removed') && l.includes('ca.crt')) ?? ''
    expect(removed).toContain('whitelist.json (events recorded as false positives (audit only))')
  })

  it('lists only the files that were there', () => {
    touch('ca.crt', 'ca.key')
    removeLlmfwFiles(dir, { keepModel: false, purge: false })
    expect(logged.join('\n')).not.toContain('whitelist.json')
  })

  it('says which files it left behind, and keeps them', () => {
    touch('ca.crt', 'license.key', 'audit.jsonl', 'suppressions.json')
    fs.mkdirSync(join(dir, 'models'))
    removeLlmfwFiles(dir, { keepModel: true, purge: false })
    const left = logged.find(l => l.includes('Left in')) ?? ''
    expect(left).toContain('license.key')
    expect(left).toContain('audit.jsonl')
    expect(left).toContain('suppressions.json')
    expect(left).toContain('models')
    expect(exists('models')).toBe(true)
  })

  it('removes the directory when nothing is left in it', () => {
    touch('ca.crt')
    fs.writeFileSync(join(dir, 'config.json'), JSON.stringify({ proxy: { mode: 'proxy' } }))
    removeLlmfwFiles(dir, { keepModel: false, purge: false })
    expect(fs.existsSync(dir)).toBe(false)
    expect(logged.join('\n')).not.toContain('Left in')
  })
})

describe('a .llm-fw.json in the working directory', () => {
  // Since 0.9.1 llm-fw never reads a config file from the working directory,
  // so it has no claim on one. uninstall used to rewrite or delete it, which,
  // run inside a cloned repository, edited that repository's file.
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'llmfw-cwd-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('is left untouched, with a note on what to do about it', () => {
    const file = join(dir, '.llm-fw.json')
    const content = JSON.stringify({ detection: { judgeEnabled: true, judgeModel: 'qwen2.5:3b' } }, null, 2)
    fs.writeFileSync(file, content)
    const note = noteProjectConfig(dir)
    expect(fs.readFileSync(file, 'utf8')).toBe(content)
    expect(note).toMatch(/not read/i)
    expect(note).toContain(file)
  })

  it('says nothing when there is none', () => {
    expect(noteProjectConfig(dir)).toBeUndefined()
  })
})
