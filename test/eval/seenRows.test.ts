import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEEN_ROWS } from './lib/seenRows.js'

/**
 * Held-out rows read while writing or checking a rule (test/eval/seen-rows.json).
 * A held-out split only measures unseen attacks for the rows nobody has
 * fitted a rule to, so every listed row must exist, be an attack, and name
 * the issue or PR that read it.
 */
const dataDir = join(dirname(fileURLToPath(import.meta.url)), 'data')

describe('seen held-out rows', () => {
  for (const [split, rows] of Object.entries(SEEN_ROWS)) {
    const data = JSON.parse(readFileSync(join(dataDir, `${split}.json`), 'utf8')) as { rows: { label: number }[] }
    for (const [index, reason] of rows) {
      it(`${split}#${index} is an attack row and names who read it`, () => {
        expect(data.rows[index]?.label).toBe(1)
        expect(reason).toMatch(/#\d+/)
      })
    }
  }

  it('lists only held-out splits', () => {
    for (const split of Object.keys(SEEN_ROWS)) {
      expect(['gandalf-ignore-instructions', 'safeguard-prompt-injection', 'deepset-prompt-injections', 'heldout', 'injecagent']).toContain(split)
    }
  })
})
