import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The nightly job accumulates benchmark history by pushing a commit from CI.
// It used to push that commit straight to main; once main gained "changes must
// be made through a pull request" the push started failing with GH006 and the
// whole nightly run went red every night. The history now lives on its own
// unprotected branch, and these tests pin that arrangement so a future edit
// cannot quietly point the push back at a protected branch.
//
// Asserted against the workflow text rather than a YAML parse: the repo has no
// YAML dependency, and the property under test — what the shell in the push
// step actually runs — is textual anyway.
const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/nightly.yml', import.meta.url)),
  'utf8',
)

/** Every `git push` the workflow runs, one per match, arguments included. */
function gitPushes(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*git push\b.*$/gm)].map((m) => m[0].trim())
}

/** Value of a `KEY: value` entry in the job's env block. */
function envValue(yaml: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm').exec(yaml)?.[1]
}

describe('nightly workflow — trend commit target', () => {
  it('declares a trend branch that is not main', () => {
    const branch = envValue(WORKFLOW, 'TREND_BRANCH')
    expect(branch).toBeDefined()
    expect(branch).not.toBe('main')
  })

  it('pushes only to the trend branch, never to a bare or protected ref', () => {
    const pushes = gitPushes(WORKFLOW)
    // A push step must exist at all — an empty list would pass the per-push
    // assertions below while silently dropping the history.
    expect(pushes.length).toBeGreaterThan(0)

    for (const push of pushes) {
      // A bare `git push` follows the checked-out branch, which is main. That
      // is the exact call that produced GH006.
      expect(push).not.toMatch(/^git push\s*$/)
      expect(push).not.toMatch(/\bmain\b/)
      // Explicit destination refspec, so the target cannot drift with whatever
      // happens to be checked out.
      expect(push).toContain('refs/heads/$TREND_BRANCH')
    }
  })

  it('does not stage the trend file from the checked-out main tree', () => {
    // `git add docs/load-results/bench-trend.jsonl` + `git commit` committed
    // onto main's HEAD. The replacement builds a one-file commit with
    // commit-tree, so nothing is staged in the working tree at all.
    expect(WORKFLOW).not.toMatch(/^\s*git add\b/m)
    expect(WORKFLOW).not.toMatch(/^\s*git commit\s+-m/m)
  })
})

describe('nightly workflow — trend history round-trip', () => {
  it('reads the prior history back before running the benchmark', () => {
    // Without the fetch the drift gate would compare each run against an empty
    // history and never fire — a gate that passes because it never ran.
    expect(WORKFLOW).toContain('git fetch --depth=1 origin')
    expect(WORKFLOW).toContain('refs/heads/$TREND_BRANCH:refs/remotes/origin/$TREND_BRANCH')
    expect(WORKFLOW).toMatch(/git show "origin\/\$TREND_BRANCH:\$TREND_FILE"/)
  })

  it('points the benchmark at the fetched history file', () => {
    const run = /run: npm run bench:trend.*$/m.exec(WORKFLOW)?.[0]
    expect(run).toBeDefined()
    expect(run).toContain('--file="$TREND_FILE"')
  })
})
