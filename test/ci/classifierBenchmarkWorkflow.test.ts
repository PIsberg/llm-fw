import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The weekly classifier benchmark (#554) exists so the classifier column of
// docs/BENCHMARK.md cannot drift unnoticed again. These tests pin what makes
// it a check rather than a log: it measures the classifier preset, compares
// the run with the committed published figures, and fails on a move. Asserted
// against the workflow text, as nightlyWorkflow.test.ts is.
const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/classifier-benchmark.yml', import.meta.url)),
  'utf8',
)
const BASELINE = JSON.parse(readFileSync(
  fileURLToPath(new URL('../eval/baselines/classifier.json', import.meta.url)),
  'utf8',
)) as { preset: string; datasets: { name: string }[] }

describe('classifier benchmark workflow', () => {
  it('runs on a schedule and on dispatch, never per pull request (an hour per run)', () => {
    expect(WORKFLOW).toMatch(/^\s+schedule:\s*\n\s+- cron: '[^']+'/m)
    expect(WORKFLOW).toMatch(/^\s+workflow_dispatch:/m)
    expect(WORKFLOW).not.toMatch(/^\s+(pull_request|push):/m)
  })

  it('reads the repository and nothing more', () => {
    expect(WORKFLOW).toMatch(/^permissions:\s*\n\s+contents: read\s*$/m)
    expect(WORKFLOW).not.toMatch(/contents: write/)
  })

  it('measures the classifier preset into a JSON file and compares it with the committed figures', () => {
    expect(WORKFLOW).toMatch(/scripts\/run-benchmark\.ts classifier --json > classifier-bench\.json/)
    expect(WORKFLOW).toMatch(/npm run bench:compare -- test\/eval\/baselines\/classifier\.json classifier-bench\.json/)
    // The compare step is the last and is not allowed to fail quietly.
    expect(WORKFLOW).not.toMatch(/continue-on-error/)
    expect(BASELINE.preset).toBe('classifier')
    expect(BASELINE.datasets.length).toBeGreaterThan(10)
  })

  it('keeps the run even when the comparison fails', () => {
    expect(WORKFLOW).toMatch(/- name: Upload the run\s*\n\s+if: always\(\)/)
  })

  it('pins every action to a commit', () => {
    const uses = [...WORKFLOW.matchAll(/^\s+uses:\s*(\S+)/gm)].map(m => m[1] ?? '')
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/)
  })
})
