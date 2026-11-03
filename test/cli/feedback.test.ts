import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { feedbackRows, run } from '../../src/cli/feedback.js'
import { checkOptions } from '../../src/cli/options.js'
import { USAGE } from '../../src/cli/usage.js'
import type { WhitelistEntry } from '../../src/types.js'

// #542: what an operator recorded as a false positive, as eval rows in a local
// file `npm run fpr` reads when present. It holds their own traffic, so it must
// never land anywhere git would pick it up, and nothing here tunes a threshold.

const entry = (over: Partial<WhitelistEntry> = {}): WhitelistEntry => ({
  id: '1', payload: 'An ordinary sentence.', stage: 'heuristic', target: 'api.anthropic.com', whitelistedAt: '2026-11-03T00:00:00Z', ...over,
})

describe('feedbackRows', () => {
  it('turns an entry into a benign eval row on the surface it arrived on', () => {
    expect(feedbackRows([entry({ surface: 'tool_result' })])).toEqual([
      { text: 'An ordinary sentence.', label: 0, class: 'operator-feedback', surface: 'tool_result' },
    ])
  })

  it('treats an entry with no surface, written before surfaces were kept, as a prompt', () => {
    expect(feedbackRows([entry()])[0]).toEqual({ text: 'An ordinary sentence.', label: 0, class: 'operator-feedback' })
  })

  it('delivers a document as a tool result, the eval harness having no document surface', () => {
    expect(feedbackRows([entry({ surface: 'document' })])[0]?.surface).toBe('tool_result')
  })

  it('drops an entry with no text, and a repeat', () => {
    expect(feedbackRows([entry({ payload: '' }), entry({ payload: '   ' }), entry(), entry({ id: '2' })])).toHaveLength(1)
  })
})

describe('llm-fw feedback-export', () => {
  let dir: string
  let saved: string | undefined
  let cwd: string
  let log: ReturnType<typeof vi.spyOn>
  let err: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    saved = process.env.LLM_FW_DIR
    dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-feedback-'))
    process.env.LLM_FW_DIR = dir
    cwd = process.cwd()
    process.chdir(dir)
    process.exitCode = undefined
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    process.chdir(cwd)
    process.exitCode = undefined
    if (saved === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const writeWhitelist = (entries: WhitelistEntry[]) => fs.writeFileSync(join(dir, 'whitelist.json'), JSON.stringify(entries))
  const printed = () => log.mock.calls.map(c => String(c[0])).join('\n')
  const errors = () => err.mock.calls.map(c => String(c[0])).join('\n')

  it('writes the rows where npm run fpr reads them, inside a checkout', () => {
    fs.mkdirSync(join(dir, 'test', 'eval', 'data'), { recursive: true })
    writeWhitelist([entry({ surface: 'tool_result' })])
    run([])
    const out = JSON.parse(fs.readFileSync(join(dir, 'test', 'eval', 'data', 'local', 'operator-feedback.json'), 'utf8')) as { rows: unknown[] }
    expect(out.rows).toEqual([{ text: 'An ordinary sentence.', label: 0, class: 'operator-feedback', surface: 'tool_result' }])
    expect(printed()).toContain('1 row')
  })

  it('refuses outside a checkout rather than dropping real traffic somewhere unexpected', () => {
    writeWhitelist([entry()])
    run([])
    expect(process.exitCode).toBe(1)
    expect(errors()).toContain('--out')
    expect(fs.readdirSync(dir)).toEqual(['whitelist.json'])
  })

  it('writes to --out when given', () => {
    writeWhitelist([entry()])
    const out = join(dir, 'mine.json')
    run(['--out', out])
    expect((JSON.parse(fs.readFileSync(out, 'utf8')) as { rows: unknown[] }).rows).toHaveLength(1)
  })

  it('refuses --out with no value', () => {
    writeWhitelist([entry()])
    run(['--out'])
    expect(process.exitCode).toBe(1)
  })

  it('says so when nothing has been recorded, and writes nothing', () => {
    fs.mkdirSync(join(dir, 'test', 'eval', 'data'), { recursive: true })
    run([])
    expect(printed()).toContain('Nothing to export')
    expect(fs.existsSync(join(dir, 'test', 'eval', 'data', 'local'))).toBe(false)
  })

  it('says how many marks it cannot export, since a mark holds only a hash', () => {
    fs.mkdirSync(join(dir, 'test', 'eval', 'data'), { recursive: true })
    writeWhitelist([entry()])
    fs.writeFileSync(join(dir, 'suppressions.json'), JSON.stringify([{ hash: 'a', preview: 'x' }, { hash: 'b', preview: 'y' }]))
    run([])
    expect(printed()).toContain('2 marked false positives')
  })

  it('is a known command with a known flag, in the help text', () => {
    expect(checkOptions('feedback-export', ['--out', 'x.json'])).toBeUndefined()
    expect(checkOptions('feedback-export', ['--frobnicate'])).toContain('--frobnicate')
    expect(USAGE).toContain('feedback-export')
  })
})
