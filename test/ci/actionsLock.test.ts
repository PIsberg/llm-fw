import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A commit SHA alone does not say which repository the code comes from:
// GitHub resolved a pinned commit through the action's whole fork network,
// so a commit pushed to a fork ran under the original action's name. The
// lockfile (.github/workflows/actions.lock, written by `gh actions-lock`)
// records the owner and repository ids with each commit, and the runner
// refuses a commit that is not in that repository's history. These tests
// check, offline, that every remote action a workflow uses has an entry, so
// a new or bumped action cannot land without one. Asserted against the
// file text, as the other workflow tests are.
const DIR = fileURLToPath(new URL('../../.github/workflows/', import.meta.url))
// Line endings normalised: a Windows checkout with core.autocrlf has CRLF
// here, and the entry pattern below, written for `':\n`, then found no
// entries at all, so the test failed on every Windows clone.
const LOCK = readFileSync(`${DIR}actions.lock`, 'utf8').replace(/\r\n/g, '\n')
const WORKFLOWS = readdirSync(DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))

// `owner/repo/sub/path@ref` is locked as `owner/repo@ref`.
const lockKey = (uses: string): string => {
  const [path = '', ref = ''] = uses.split('@')
  return `${path.split('/').slice(0, 2).join('/')}@${ref}`
}
const remoteUses = (text: string): string[] =>
  [...text.matchAll(/^\s+(?:-\s+)?uses:\s*['"]?([^\s'"#]+)/gm)]
    .map(m => m[1] ?? '')
    .filter(u => !u.startsWith('./') && !u.startsWith('docker://'))

// The lockfile's per-workflow lists and its dependency entries.
const workflowSection = (file: string): string[] => {
  const start = LOCK.indexOf(`'.github/workflows/${file}':`)
  if (start < 0) return []
  const rest = LOCK.slice(start).split('\n').slice(1)
  const items: string[] = []
  for (const line of rest) {
    const m = line.match(/^\s+-\s+'([^']+)'/)
    if (!m) break
    items.push(m[1] ?? '')
  }
  return items
}
const dependencies = new Map<string, string>()
for (const m of LOCK.matchAll(/^ {4}'([^']+@[^']+)':\n((?: {8}.*\n?)+)/gm)) dependencies.set(m[1] ?? '', m[2] ?? '')

describe('actions lockfile', () => {
  it('lists every remote action of every workflow', () => {
    expect(WORKFLOWS.length).toBeGreaterThan(0)
    for (const file of WORKFLOWS) {
      const locked = new Set(workflowSection(file))
      for (const uses of remoteUses(readFileSync(`${DIR}${file}`, 'utf8'))) {
        expect(locked.has(lockKey(uses)), `${file}: ${uses} has no lockfile entry; run gh actions-lock`).toBe(true)
      }
    }
  })

  it('records the commit and the repository identity of every locked action', () => {
    expect(dependencies.size).toBeGreaterThan(0)
    for (const file of WORKFLOWS) {
      for (const key of workflowSection(file)) {
        const entry = dependencies.get(key)
        expect(entry, `${key} is listed for ${file} but has no dependency entry`).toBeDefined()
        const sha = key.split('@')[1] ?? ''
        expect(entry, key).toMatch(new RegExp(`commit: 'sha1-${sha}'`))
        expect(entry, key).toMatch(/owner_id: \d+/)
        expect(entry, key).toMatch(/repo_id: \d+/)
      }
    }
  })

  it('still pins every action to a commit in the workflow itself', () => {
    // Kept as well as the lockfile: a run where lockfiles are not enforced
    // still gets the exact commit, and the Scorecard pinning check reads it.
    for (const file of WORKFLOWS) {
      for (const uses of remoteUses(readFileSync(`${DIR}${file}`, 'utf8'))) expect(uses, `${file}: ${uses}`).toMatch(/@[0-9a-f]{40}$/)
    }
  })
})
