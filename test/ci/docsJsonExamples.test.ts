import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A ```json block in the docs is something a reader pastes into
// ~/.llm-fw/config.json. The trustedPaths example in docs/guides/tuning.md
// carried "C:\dev\private" with single backslashes, which is not JSON, so the
// pasted file failed to load. Every ```json block in a tracked Markdown file
// must parse; a block that needs comments or ellipses is tagged ```jsonc.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function jsonBlocks(): { where: string; body: string }[] {
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
  const blocks: { where: string; body: string }[] = []
  for (const file of files) {
    const text = readFileSync(`${ROOT}${file}`, 'utf8').replace(/\r\n/g, '\n')
    const fence = /^([ \t]*)```json[ \t]*\n([\s\S]*?)^\1```/gm
    let m: RegExpExecArray | null
    while ((m = fence.exec(text)) !== null) {
      blocks.push({ where: `${file}:${text.slice(0, m.index).split('\n').length}`, body: m[2] ?? '' })
    }
  }
  return blocks
}

describe('JSON examples in the docs', () => {
  const blocks = jsonBlocks()

  it('finds the examples it is meant to check', () => {
    expect(blocks.some(b => b.where.startsWith('docs/guides/tuning.md:'))).toBe(true)
  })

  it('every ```json block parses', () => {
    const bad = blocks.flatMap(b => {
      try { JSON.parse(b.body); return [] } catch (err) { return [`${b.where}: ${(err as Error).message}`] }
    })
    expect(bad).toEqual([])
  })
})
