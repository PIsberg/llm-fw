import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve('scripts/check-links.mjs')

let dir: string | undefined

function run(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fw-links-'))
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' })
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('npm run docs:links', () => {
  it('finds a heading by the anchor GitHub gives it, inline code included', () => {
    const result = run({
      'a.md': '[setup](b.md#the-agy-client)\n',
      'b.md': '## The `agy` client\n',
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('still reports an anchor that matches no heading', () => {
    const result = run({
      'a.md': '[setup](b.md#the-client)\n',
      'b.md': '## The `agy` client\n',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('b.md#the-client')
  })

  it('does not take a heading from a fenced example', () => {
    const result = run({
      'a.md': '[setup](b.md#only-an-example)\n',
      'b.md': '```\n## Only an example\n```\n',
    })
    expect(result.status).toBe(1)
  })

  it('does not read a link out of inline code', () => {
    const result = run({ 'a.md': 'The pattern `[x](missing.md)` is a regex.\n' })
    expect(result.status).toBe(0)
  })
})
