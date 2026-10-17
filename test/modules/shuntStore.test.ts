import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { StoredOriginals } from '../../src/modules/shuntStore.js'

// Slice S4 of the tool result shunt: the folder of stored originals and of
// remembered outcome files, against specs/001-tool-result-shunt/data-model.md
// "Stored original" (FR-006, FR-021 to FR-025). Every test runs against a
// scratch LLM_FW_DIR, set and removed around each test the way
// test/gateway/gateway-modules.e2e.test.ts does, so the real ~/.llm-fw is
// never touched.

const win = process.platform === 'win32'
const HOUR = 3_600_000

let root: string
const savedDir = process.env.LLM_FW_DIR
const savedUser = process.env.USERNAME

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shunt-store-'))
  process.env.LLM_FW_DIR = root
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (savedDir === undefined) delete process.env.LLM_FW_DIR
  else process.env.LLM_FW_DIR = savedDir
  if (savedUser === undefined) delete process.env.USERNAME
  else process.env.USERNAME = savedUser
  fs.rmSync(root, { recursive: true, force: true })
})

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const folder = () => join(root, 'tool-results')
const names = () => (fs.existsSync(folder()) ? fs.readdirSync(folder()).sort() : [])
const sizeOf = (name: string) => fs.statSync(join(folder(), name)).size
const onDisk = () => names().reduce((n, f) => n + sizeOf(f), 0)
const outcomeFile = (key: string) => join(folder(), `${key}.outcome`)
const age = (file: string, ms: number) => {
  const t = new Date(Date.now() - ms)
  fs.utimesSync(file, t, t)
}
const mtimeAge = (file: string) => Date.now() - fs.statSync(file).mtimeMs
const mk = (cap = 50_000_000) => new StoredOriginals(() => cap)
/** ASCII text of exactly `bytes` bytes, distinct per tag. */
const text = (tag: string, bytes = 100) => `${tag}:`.padEnd(bytes, 'x')
const key = (tag: string) => sha(`Bash\0${tag}`)

/** The account names an icacls listing grants access to, lower-cased (the part after the last backslash). */
function aclAccounts(path: string): string[] {
  const out = execFileSync('icacls', [path], { encoding: 'utf8' })
  return [...out.matchAll(/([^\\\s:()]+):\(/g)].map(m => m[1]!.toLowerCase())
}

describe('StoredOriginals: where files go (FR-021, FR-022, US7-1, US2-6)', () => {
  it('keeps its folder under the llm-fw directory, resolved at each call rather than at construction', async () => {
    const store = mk()
    expect(store.dir()).toBe(folder())
    const other = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shunt-other-'))
    try {
      process.env.LLM_FW_DIR = other
      expect(store.dir()).toBe(join(other, 'tool-results'))
      expect(await store.write(text('a'))).toBe('stored')
      expect(fs.readdirSync(join(other, 'tool-results'))).toHaveLength(1)
      expect(fs.existsSync(folder())).toBe(false)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('writes nothing outside that folder, and only stored originals and outcome files in it', async () => {
    const store = mk()
    expect(await store.write(text('a'))).toBe('stored')
    expect(await store.writeOutcome(key('a'), { condensed: 'facts' })).toBe('stored')
    expect(await store.writeOutcome(key('b'), { whole: 'flagged' })).toBe('stored')
    expect(fs.readdirSync(root)).toEqual(['tool-results'])
    for (const name of names()) expect(name).toMatch(/^(?:[0-9a-f]{64}\.txt|[0-9a-f]{64}\.outcome)$/)
    expect(names()).toHaveLength(3)
  })

  it('gives each content one absolute path of the form <folder>/<sha256 hex>.txt, revealing nothing of the content', () => {
    const store = mk()
    const secret = 'SECRET-MARKER-9f3a'
    const path = store.pathFor(`api key is ${secret}`)
    expect(isAbsolute(path)).toBe(true)
    expect(path).toBe(join(folder(), `${sha(`api key is ${secret}`)}.txt`))
    expect(path).not.toContain(secret)
    expect(store.pathFor(`api key is ${secret}`)).toBe(path)
    expect(store.pathFor(`api key is ${secret}!`)).not.toBe(path)
    expect(new StoredOriginals(() => 1).pathFor(`api key is ${secret}`)).toBe(path)
  })

  it('hashes the UTF-8 bytes of the text', () => {
    const t = 'héllo 世界 😀'
    expect(mk().pathFor(t)).toBe(join(folder(), `${sha(t)}.txt`))
  })

  it('writes the same content once: a second write is stored and adds no file', async () => {
    const store = mk()
    const t = text('same', 500)
    expect(await store.write(t)).toBe('stored')
    expect(await store.write(t)).toBe('stored')
    expect(names()).toEqual([`${sha(t)}.txt`])
    expect(store.stats()).toEqual({ files: 1, bytes: 500 })
  })
})

describe('StoredOriginals.write: the exact original (FR-021, US2-4, US2-5)', () => {
  it.each([
    ['plain ascii', 'line one\nline two\n'],
    ['CRLF line endings kept', 'a\r\nb\r\n'],
    ['unicode', 'héllo 世界 😀 ü'],
    ['a byte order mark', '﻿starts with a BOM'],
    ['a NUL and control characters', 'a\u0000b\u001b[31mred\u001b[0m'],
    ['no trailing newline', 'last line without a newline'],
    ['one megabyte', 'abcdefghij'.repeat(100_000)],
  ])('stores %s byte for byte', async (_name, t) => {
    const store = mk()
    expect(await store.write(t)).toBe('stored')
    expect(fs.readFileSync(store.pathFor(t)).equals(Buffer.from(t, 'utf8'))).toBe(true)
  })

  it('leaves no file and no temp file behind when the path cannot be written, and gives failed', async () => {
    const store = mk(1000)
    // Build the running totals while the folder is empty.
    expect(await store.write(text('warm', 10))).toBe('stored')
    await store.remove(text('warm', 10))

    // A directory where the file belongs: the final rename must fail.
    const a = text('a', 600)
    fs.mkdirSync(store.pathFor(a))
    expect(await store.write(a)).toBe('failed')
    expect(names()).toEqual([`${sha(a)}.txt`])
    expect(fs.statSync(store.pathFor(a)).isDirectory()).toBe(true)

    // The failed write released what it reserved against the cap.
    fs.rmdirSync(store.pathFor(a))
    expect(await store.write(text('b', 600))).toBe('stored')
  })

  it('does not report stored, and creates nothing, when the llm-fw directory cannot hold a folder', async () => {
    const blocker = join(root, 'not-a-directory')
    fs.writeFileSync(blocker, 'a regular file where the llm-fw directory should be')
    process.env.LLM_FW_DIR = join(blocker, 'llm-fw')
    const store = mk()
    const result = await store.write(text('a'))
    expect(['failed', 'unrestricted']).toContain(result)
    expect(fs.statSync(blocker).isFile()).toBe(true)
    expect(fs.readdirSync(root)).toEqual(['not-a-directory'])
  })

  it.runIf(!win && typeof process.getuid === 'function' && process.getuid() !== 0)(
    'does not report stored, and leaves no temp file, when the folder cannot be written',
    async () => {
      const store = mk()
      expect(await store.write(text('warm'))).toBe('stored')
      const before = names()
      fs.chmodSync(folder(), 0o500)
      try {
        expect(['failed', 'unrestricted']).toContain(await store.write(text('a', 300)))
      } finally {
        fs.chmodSync(folder(), 0o700)
      }
      expect(names()).toEqual(before)
    },
  )

  it('does not put the original or its hash into any log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    const marker = 'MARKER-never-logged-5521'
    const store = mk(300)
    const t = `${marker} ${'x'.repeat(200)}`
    await store.write(t)
    await store.write(`${marker} other ${'y'.repeat(400)}`)
    await store.writeOutcome(key(marker), { condensed: `${marker} facts` })
    fs.mkdirSync(store.pathFor(`${marker} blocked`))
    await store.write(`${marker} blocked`)
    fs.rmdirSync(store.pathFor(`${marker} blocked`))
    await store.sweep(HOUR)
    await store.purge()
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(marker)
  })
})

describe('StoredOriginals: who can read the folder (FR-023, US7-2, D5)', () => {
  it.runIf(!win)('makes the folder 0700 and every file 0600 (POSIX)', async () => {
    const store = mk()
    expect(await store.write(text('a'))).toBe('stored')
    expect(await store.writeOutcome(key('a'), { condensed: 'facts' })).toBe('stored')
    expect(fs.statSync(folder()).mode & 0o777).toBe(0o700)
    expect(fs.statSync(store.pathFor(text('a'))).mode & 0o777).toBe(0o600)
    expect(fs.statSync(outcomeFile(key('a'))).mode & 0o777).toBe(0o600)
  })

  it.runIf(!win)('tightens a folder that already exists with looser bits on first use (POSIX)', async () => {
    fs.mkdirSync(folder(), { mode: 0o755 })
    fs.chmodSync(folder(), 0o755)
    const store = mk()
    expect(await store.write(text('a'))).toBe('stored')
    expect(fs.statSync(folder()).mode & 0o777).toBe(0o700)
  })

  it.runIf(win)('grants the folder, a stored original and an outcome file to the running account and SYSTEM only (Windows)', async () => {
    const user = process.env.USERNAME!.toLowerCase()
    const store = mk()
    expect(await store.write(text('a'))).toBe('stored')
    expect(await store.writeOutcome(key('a'), { condensed: 'facts' })).toBe('stored')
    for (const path of [folder(), store.pathFor(text('a')), outcomeFile(key('a'))]) {
      const accounts = aclAccounts(path)
      expect(accounts, path).toContain(user)
      expect(accounts, path).toContain('system')
      expect(accounts.filter(a => a !== user && a !== 'system'), path).toEqual([])
    }
  })

  it.runIf(win)('restricts a folder that already exists with the default inherited access (Windows)', async () => {
    fs.mkdirSync(folder())
    const user = process.env.USERNAME!.toLowerCase()
    const store = mk()
    expect(await store.write(text('a'))).toBe('stored')
    const accounts = aclAccounts(folder())
    expect(accounts.filter(a => a !== user && a !== 'system')).toEqual([])
  })

  it.runIf(win)('gives unrestricted, and writes nothing, when the account cannot be named (Windows, USERNAME unset)', async () => {
    delete process.env.USERNAME
    const store = mk()
    expect(await store.write(text('a'))).toBe('unrestricted')
    expect(await store.writeOutcome(key('a'), { whole: 'flagged' })).toBe('unrestricted')
    expect(names()).toEqual([])
    expect(store.stats()).toEqual({ files: 0, bytes: 0 })
  })

  it.runIf(win)('reads no outcome file when access cannot be confirmed (Windows, USERNAME unset)', async () => {
    const earlier = mk()
    expect(await earlier.writeOutcome(key('a'), { condensed: 'facts' })).toBe('stored')
    expect(await mk().readOutcome(key('a'))).toEqual({ condensed: 'facts' })

    delete process.env.USERNAME
    expect(await mk().readOutcome(key('a'))).toBeNull()
  })
})

describe('StoredOriginals: the size cap (FR-025, US7-7, SC-011)', () => {
  it('lets concurrent writes reserve against the cap: the ones that do not fit get full, and nothing is deleted', async () => {
    const store = mk(2500)
    const texts = Array.from({ length: 5 }, (_, i) => text(`t${i}`, 1000))
    const results = await Promise.all(texts.map(t => store.write(t)))
    expect(results.filter(r => r === 'stored')).toHaveLength(2)
    expect(results.filter(r => r === 'full')).toHaveLength(3)
    expect(names()).toHaveLength(2)
    expect(onDisk()).toBeLessThanOrEqual(2500)
    for (const [i, r] of results.entries()) {
      expect(fs.existsSync(store.pathFor(texts[i]!))).toBe(r === 'stored')
    }
    expect(store.stats()).toEqual({ files: 2, bytes: 2000 })
  })

  it('accepts a write that brings the total exactly to the cap, and refuses the next', async () => {
    const store = mk(2000)
    expect(await store.write(text('a', 1000))).toBe('stored')
    expect(await store.write(text('b', 1000))).toBe('stored')
    expect(await store.write(text('c', 1))).toBe('full')
    expect(names()).toHaveLength(2)
  })

  it('deletes no unexpired original to make room', async () => {
    const store = mk(1000)
    const a = text('a', 800)
    expect(await store.write(a)).toBe('stored')
    expect(await store.write(text('b', 800))).toBe('full')
    expect(fs.readFileSync(store.pathFor(a), 'utf8')).toBe(a)
    expect(names()).toEqual([`${sha(a)}.txt`])
  })

  it('counts an original that is already stored as stored, even with the folder at the cap', async () => {
    const store = mk(1000)
    const a = text('a', 1000)
    expect(await store.write(a)).toBe('stored')
    expect(await store.write(a)).toBe('stored')
    expect(store.stats()).toEqual({ files: 1, bytes: 1000 })
  })

  it('reads the cap at each write, so the operator can change it live', async () => {
    let cap = 1000
    const store = new StoredOriginals(() => cap)
    expect(await store.write(text('a', 1000))).toBe('stored')
    expect(await store.write(text('b', 500))).toBe('full')
    cap = 2000
    expect(await store.write(text('b', 500))).toBe('stored')
    cap = 100
    expect(await store.write(text('c', 10))).toBe('full')
  })

  it('counts what is already in the folder, found by a scan on first use', async () => {
    fs.mkdirSync(folder())
    fs.writeFileSync(join(folder(), `${sha('old1')}.txt`), 'x'.repeat(400))
    fs.writeFileSync(join(folder(), `${key('old2')}.outcome`), '{"whole":"flagged"}'.padEnd(200, ' '))
    const store = mk(1000)
    expect(await store.write(text('a', 500))).toBe('full')
    expect(await store.write(text('b', 400))).toBe('stored')
  })

  it('counts outcome files against the cap too', async () => {
    const store = mk(1000)
    expect(await store.write(text('a', 700))).toBe('stored')
    expect(await store.writeOutcome(key('big'), { condensed: 'y'.repeat(400) })).toBe('full')
    expect(names().filter(n => n.endsWith('.outcome'))).toEqual([])
    expect(await store.readOutcome(key('big'))).toBeNull()
    expect(await store.writeOutcome(key('small'), { whole: 'flagged' })).toBe('stored')
    expect(onDisk()).toBeLessThanOrEqual(1000)
  })
})

describe('StoredOriginals: outcome files (FR-006, D9, D11)', () => {
  it('round-trips both shapes', async () => {
    const store = mk()
    const condensed = { condensed: '[llm-fw: tool output condensed from 400 lines.\n/some/path.txt\n]\n3 tests failed' }
    expect(await store.writeOutcome(key('a'), condensed)).toBe('stored')
    expect(await store.writeOutcome(key('b'), { whole: 'flagged' })).toBe('stored')
    expect(await store.readOutcome(key('a'))).toEqual(condensed)
    expect(await store.readOutcome(key('b'))).toEqual({ whole: 'flagged' })
    // And through a second instance: the file, not memory, holds it.
    expect(await mk().readOutcome(key('a'))).toEqual(condensed)
  })

  it('writes <key>.outcome holding the JSON of the outcome and nothing else', async () => {
    const store = mk()
    await store.writeOutcome(key('a'), { condensed: 'the condensed text' })
    await store.writeOutcome(key('b'), { whole: 'worker-failed' })
    expect(JSON.parse(fs.readFileSync(outcomeFile(key('a')), 'utf8'))).toEqual({ condensed: 'the condensed text' })
    expect(JSON.parse(fs.readFileSync(outcomeFile(key('b')), 'utf8'))).toEqual({ whole: 'worker-failed' })
  })

  it('replaces an outcome with a second write and moves the total by the difference', async () => {
    const store = mk()
    await store.writeOutcome(key('a'), { condensed: 'a'.repeat(100) })
    const first = sizeOf(`${key('a')}.outcome`)
    expect(store.stats()).toEqual({ files: 0, bytes: first })
    expect(await store.writeOutcome(key('a'), { condensed: 'b'.repeat(450) })).toBe('stored')
    const second = sizeOf(`${key('a')}.outcome`)
    expect(second).toBeGreaterThan(first)
    expect(await store.readOutcome(key('a'))).toEqual({ condensed: 'b'.repeat(450) })
    expect(names()).toEqual([`${key('a')}.outcome`])
    expect(store.stats().bytes).toBe(second)
    expect(await store.writeOutcome(key('a'), { whole: 'flagged' })).toBe('stored')
    expect(store.stats().bytes).toBe(sizeOf(`${key('a')}.outcome`))
  })

  it('reserves only the growth when it replaces an outcome, and keeps the old one when the new one does not fit', async () => {
    const store = mk(520)
    expect(await store.writeOutcome(key('a'), { condensed: 'a'.repeat(100) })).toBe('stored')
    expect(await store.writeOutcome(key('a'), { condensed: 'b'.repeat(450) })).toBe('stored')
    expect(await store.writeOutcome(key('a'), { condensed: 'c'.repeat(600) })).toBe('full')
    expect(await store.readOutcome(key('a'))).toEqual({ condensed: 'b'.repeat(450) })
  })

  describe('readOutcome gives null for anything that is not exactly one of the two shapes', () => {
    it('gives null for a missing file', async () => {
      const store = mk()
      await store.writeOutcome(key('other'), { whole: 'flagged' })
      expect(await store.readOutcome(key('missing'))).toBeNull()
    })

    it.each([
      ['a file that is not JSON', '{not json'],
      ['an empty file', ''],
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a JSON string', '"condensed"'],
      ['an object with neither key', '{}'],
      ['an object with an unrelated key', '{"other":"x"}'],
      ['an object with both keys', '{"condensed":"a","whole":"flagged"}'],
      ['a non-string condensed', '{"condensed":5}'],
      ['a null condensed', '{"condensed":null}'],
      ['a non-string whole', '{"whole":["flagged"]}'],
      ['a null whole', '{"whole":null}'],
    ])('gives null for %s', async (_name, content) => {
      const store = mk()
      await store.writeOutcome(key('other'), { whole: 'flagged' })
      fs.writeFileSync(outcomeFile(key('bad')), content)
      expect(await store.readOutcome(key('bad'))).toBeNull()
    })
  })

  it('touchOutcome gives false for a missing file, and true and a fresh mtime for one that is there', async () => {
    const store = mk()
    expect(await store.touchOutcome(key('a'))).toBe(false)
    await store.writeOutcome(key('a'), { whole: 'flagged' })
    age(outcomeFile(key('a')), 5 * HOUR)
    expect(mtimeAge(outcomeFile(key('a')))).toBeGreaterThan(4 * HOUR)
    expect(await store.touchOutcome(key('a'))).toBe(true)
    expect(mtimeAge(outcomeFile(key('a')))).toBeLessThan(60_000)
  })
})

describe('StoredOriginals.touch and remove (FR-024, D11)', () => {
  it('touch gives false for a missing file, and true and a fresh mtime for one that is there', async () => {
    const store = mk()
    expect(await store.touch(text('a'))).toBe(false)
    await store.write(text('a'))
    age(store.pathFor(text('a')), 5 * HOUR)
    expect(await store.touch(text('a'))).toBe(true)
    expect(mtimeAge(store.pathFor(text('a')))).toBeLessThan(60_000)
  })

  it('remove deletes the stored original, leaves the outcome file, and lowers the totals', async () => {
    const store = mk(1000)
    const a = text('a', 800)
    await store.write(a)
    await store.writeOutcome(key('a'), { whole: 'flagged' })
    const outcomeBytes = sizeOf(`${key('a')}.outcome`)
    expect(store.stats()).toEqual({ files: 1, bytes: 800 + outcomeBytes })
    await store.remove(a)
    expect(fs.existsSync(store.pathFor(a))).toBe(false)
    expect(fs.existsSync(outcomeFile(key('a')))).toBe(true)
    expect(store.stats()).toEqual({ files: 0, bytes: outcomeBytes })
    // The room it held is free again.
    expect(await store.write(text('b', 900))).toBe('stored')
  })

  it('remove resolves for an original that is not there', async () => {
    const store = mk()
    await store.write(text('a'))
    await expect(store.remove(text('missing'))).resolves.toBeUndefined()
    expect(names()).toHaveLength(1)
  })
})

describe('StoredOriginals.stats', () => {
  it('counts .txt files as files and every file in bytes', async () => {
    const store = mk()
    await store.write(text('a', 300))
    await store.write(text('b', 200))
    await store.writeOutcome(key('a'), { condensed: 'x'.repeat(50) })
    await store.writeOutcome(key('b'), { whole: 'flagged' })
    expect(names()).toHaveLength(4)
    expect(store.stats()).toEqual({ files: 2, bytes: onDisk() })
  })

  it('is empty before anything is stored', () => {
    expect(mk().stats()).toEqual({ files: 0, bytes: 0 })
  })
})

describe('StoredOriginals.sweep (FR-024, FR-025, US7-4, US7-5)', () => {
  it('deletes what no request carried for longer than the retention, temp files included, and returns how many', async () => {
    const store = mk()
    const [a, b] = [text('a', 300), text('b', 200)]
    await store.write(a)
    await store.write(b)
    await store.writeOutcome(key('a'), { condensed: 'old facts' })
    await store.writeOutcome(key('b'), { condensed: 'new facts' })
    const stray = join(folder(), `${sha(a)}.abc123.tmp`)
    fs.writeFileSync(stray, 'half written')
    for (const f of [store.pathFor(a), outcomeFile(key('a')), stray]) age(f, 25 * HOUR)
    age(store.pathFor(b), 23 * HOUR)

    expect(await store.sweep(24 * HOUR)).toBe(3)
    expect(names()).toEqual([`${sha(b)}.txt`, `${key('b')}.outcome`].sort())
    expect(store.stats()).toEqual({ files: 1, bytes: onDisk() })
  })

  it('compares by mtime: a file a request carried again before expiry starts a new retention period', async () => {
    const store = mk()
    const a = text('a')
    await store.write(a)
    age(store.pathFor(a), 30 * HOUR)
    expect(await store.touch(a)).toBe(true)
    expect(await store.sweep(24 * HOUR)).toBe(0)
    expect(fs.existsSync(store.pathFor(a))).toBe(true)
    age(store.pathFor(a), 30 * HOUR)
    expect(await store.sweep(24 * HOUR)).toBe(1)
    expect(fs.existsSync(store.pathFor(a))).toBe(false)
  })

  it('deletes expired files left by an earlier run, with no module state to go by', async () => {
    fs.mkdirSync(folder())
    const left = [`${sha('x')}.txt`, `${key('x')}.outcome`, `${sha('y')}.def456.tmp`]
    for (const name of left) {
      fs.writeFileSync(join(folder(), name), 'left over')
      age(join(folder(), name), 48 * HOUR)
    }
    fs.writeFileSync(join(folder(), `${sha('fresh')}.txt`), 'fresh')
    expect(await mk().sweep(24 * HOUR)).toBe(3)
    expect(names()).toEqual([`${sha('fresh')}.txt`])
  })

  it('rebuilds the totals from the folder', async () => {
    fs.mkdirSync(folder())
    fs.writeFileSync(join(folder(), `${sha('one')}.txt`), 'x'.repeat(300))
    fs.writeFileSync(join(folder(), `${sha('two')}.txt`), 'x'.repeat(200))
    fs.writeFileSync(join(folder(), `${key('one')}.outcome`), '{"whole":"flagged"}')
    const store = mk()
    expect(await store.sweep(24 * HOUR)).toBe(0)
    expect(store.stats()).toEqual({ files: 2, bytes: 300 + 200 + '{"whole":"flagged"}'.length })
  })

  it('returns 0 when there is no folder yet', async () => {
    expect(await mk().sweep(HOUR)).toBe(0)
  })
})

describe('StoredOriginals.purge (US7-6, FR-025)', () => {
  it('deletes every file in the folder, counts them, and empties the totals', async () => {
    const store = mk()
    await store.write(text('a'))
    await store.write(text('b'))
    await store.writeOutcome(key('a'), { condensed: 'facts' })
    fs.writeFileSync(join(folder(), `${sha('a')}.zzz999.tmp`), 'half written')
    fs.writeFileSync(join(folder(), 'stray.bin'), 'not ours')
    expect(names()).toHaveLength(5)

    expect(await store.purge()).toBe(5)
    expect(names()).toEqual([])
    expect(store.stats()).toEqual({ files: 0, bytes: 0 })
  })

  it('returns 0 when there is no folder yet', async () => {
    expect(await mk().purge()).toBe(0)
  })

  it('lets a later request write the original back at the same path', async () => {
    const store = mk()
    const a = text('a', 300)
    await store.write(a)
    const path = store.pathFor(a)
    await store.purge()
    expect(await store.touch(a)).toBe(false)
    expect(await store.write(a)).toBe('stored')
    expect(store.pathFor(a)).toBe(path)
    expect(fs.readFileSync(path, 'utf8')).toBe(a)
  })
})

describe('StoredOriginals.startSweeping (FR-025)', () => {
  /** Real event-loop turns, so a sweep that does file I/O under faked timers can finish. */
  const until = async (done: () => boolean, ms = 3000) => {
    const end = Date.now() + ms
    while (!done() && Date.now() < end) await new Promise<void>(r => setImmediate(r))
    return done()
  }
  const settle = async (ms = 120) => {
    const end = Date.now() + ms
    while (Date.now() < end) await new Promise<void>(r => setImmediate(r))
  }
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const expired = (tag: string, ms = 48 * HOUR) => {
    fs.mkdirSync(folder(), { recursive: true })
    const file = join(folder(), `${sha(tag)}.txt`)
    fs.writeFileSync(file, tag)
    age(file, ms)
    return file
  }

  it('sweeps at once, then every interval, reading the retention getter each time', async () => {
    fakeTimers()
    const store = mk()
    let retention = 24 * HOUR
    const first = expired('first')
    const stop = store.startSweeping(() => retention, 1000)
    try {
      expect(await until(() => !fs.existsSync(first))).toBe(true)
      await settle(60)

      const second = expired('second')
      const recent = expired('recent', 30 * 60_000)
      vi.advanceTimersByTime(999)
      await settle()
      expect(fs.existsSync(second)).toBe(true)
      vi.advanceTimersByTime(1)
      expect(await until(() => !fs.existsSync(second))).toBe(true)
      expect(fs.existsSync(recent)).toBe(true)

      // A shorter retention reaches the file the last sweep spared.
      await settle(30)
      retention = 10 * 60_000
      vi.advanceTimersByTime(1000)
      expect(await until(() => !fs.existsSync(recent))).toBe(true)
    } finally {
      stop()
    }
  })

  it('stops sweeping once the returned function is called', async () => {
    fakeTimers()
    const store = mk()
    const stop = store.startSweeping(() => 24 * HOUR, 1000)
    await settle(50)
    stop()
    const late = expired('late')
    vi.advanceTimersByTime(10_000)
    await settle(200)
    expect(fs.existsSync(late)).toBe(true)
  })

  it('sweeps at least once an hour by default', async () => {
    fakeTimers()
    const store = mk()
    const stop = store.startSweeping(() => 24 * HOUR)
    try {
      await settle(50)
      const late = expired('late')
      vi.advanceTimersByTime(HOUR)
      expect(await until(() => !fs.existsSync(late))).toBe(true)
    } finally {
      stop()
    }
  })

  it('sweeps outcome files and stored originals alike', async () => {
    fakeTimers()
    const store = mk()
    await store.writeOutcome(key('a'), { whole: 'flagged' })
    await store.write(text('a'))
    age(outcomeFile(key('a')), 48 * HOUR)
    age(store.pathFor(text('a')), 48 * HOUR)
    const stop = store.startSweeping(() => 24 * HOUR, 1000)
    try {
      expect(await until(() => names().length === 0)).toBe(true)
    } finally {
      stop()
    }
  })
})
