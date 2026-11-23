import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, deepMerge } from '../../src/config/config.js'

// #864: config files were merged with no check of what they held. A
// threshold written as a string made every `score >= threshold` false and
// turned the stage off; a mistyped mode matched no comparison and stopped
// blocking; a port of 70000 failed only when the listener bound. A file
// holding any of these is now refused at load, naming the key, as a file
// that is not JSON already was (#853). On a hot reload the running config is
// left as it was.
describe('config files are checked against the shape of the defaults (#864)', () => {
  let dir: string
  const saved = { dir: process.env.LLM_FW_DIR, config: process.env.LLM_FW_CONFIG }

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-validate-'))
    process.env.LLM_FW_DIR = dir
    delete process.env.LLM_FW_CONFIG
  })
  afterEach(() => {
    if (saved.dir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = saved.dir
    if (saved.config === undefined) delete process.env.LLM_FW_CONFIG
    else process.env.LLM_FW_CONFIG = saved.config
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const withFile = (settings: unknown) => fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(settings))

  it.each([
    ['a threshold written as a string', { detection: { embeddingBlockThreshold: '0.9' } }, /detection\.embeddingBlockThreshold/],
    ['a boolean written as a string', { detection: { judgeEnabled: 'true' } }, /detection\.judgeEnabled/],
    ['a mistyped DLP mode', { dlp: { mode: 'blcok' } }, /dlp\.mode/],
    ['a mistyped detector mode', { indirectInstruction: { mode: 'bock' } }, /indirectInstruction\.mode/],
    ['a mistyped enforcement', { enforcement: 'obsrve' }, /enforcement/],
    ['a port out of range', { proxy: { port: 70000 } }, /proxy\.port/],
    ['an object where a list belongs', { proxy: { interceptDomains: { a: 1 } } }, /proxy\.interceptDomains/],
    ['a number where a section belongs', { dlp: 5 }, /dlp/],
  ])('refuses %s, naming the key', async (_label, settings, key) => {
    withFile(settings)
    await expect(loadConfig()).rejects.toThrow(key)
  })

  it('names the file the bad value is in', async () => {
    withFile({ dlp: { mode: 'blcok' } })
    await expect(loadConfig()).rejects.toThrow(join(dir, 'config.json'))
  })

  it('checks a project file named by LLM_FW_CONFIG the same way', async () => {
    const project = join(dir, 'project.json')
    fs.writeFileSync(project, JSON.stringify({ detection: { heuristicBlockThreshold: 'high' } }))
    process.env.LLM_FW_CONFIG = project
    await expect(loadConfig()).rejects.toThrow(/detection\.heuristicBlockThreshold/)
  })

  it('loads a valid file, and tolerates a key it does not know', async () => {
    withFile({ dlp: { mode: 'audit' }, proxy: { port: 18080 }, detection: { embeddingBlockThreshold: 0.85 }, someFutureKey: { x: 1 } })
    const c = await loadConfig()
    expect(c.dlp.mode).toBe('audit')
    expect(c.proxy.port).toBe(18080)
    expect(c.detection.embeddingBlockThreshold).toBe(0.85)
  })
})

describe('deepMerge never writes through a prototype key (#864)', () => {
  it('drops __proto__, constructor and prototype', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"a":2}') as Record<string, unknown>
    const merged = deepMerge({ a: 1 } as Record<string, unknown>, source)
    expect(merged.a).toBe(2)
    expect((merged as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined()
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
  })
})
