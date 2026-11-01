import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// #598: the nightly performance trend keeps its history the way the benchmark
// trend does (nightlyWorkflow.test.ts): a one-file commit on an unprotected
// orphan branch, never a push to main, which requires a pull request and a
// review a scheduled job cannot supply. Asserted on the workflow text, as
// there: the property is what the shell runs.
const WORKFLOW = readFileSync(fileURLToPath(new URL('../../.github/workflows/perf-trend.yml', import.meta.url)), 'utf8')
const envValue = (key: string): string | undefined => new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm').exec(WORKFLOW)?.[1]
const stepWith = (needle: string): string | undefined => WORKFLOW.split(/\n(?=\s*- name:)/).find(s => s.includes(needle))

describe('nightly performance trend workflow', () => {
  it('keeps the history on its own branch, not main and not the benchmark trend', () => {
    expect(envValue('TREND_BRANCH')).toBe('perf-trend-data')
    expect(envValue('TREND_FILE')).toBe('perf-trend.jsonl')
  })

  it('pushes only to the trend branch, and never stages from the checked-out main tree', () => {
    const pushes = [...WORKFLOW.matchAll(/^\s*git push\b.*$/gm)].map(m => m[0].trim())
    expect(pushes).toEqual(['git push origin "$commit:refs/heads/$TREND_BRANCH"'])
    expect(WORKFLOW).not.toMatch(/^\s*git add\b/m)
    expect(WORKFLOW).not.toMatch(/^\s*git commit\s+-m/m)
  })

  it('reads the prior history back before running', () => {
    expect(WORKFLOW).toContain('refs/heads/$TREND_BRANCH:refs/remotes/origin/$TREND_BRANCH')
    expect(WORKFLOW).toMatch(/git show "origin\/\$TREND_BRANCH:\$TREND_FILE"/)
    expect(WORKFLOW.indexOf('Fetch trend history')).toBeLessThan(WORKFLOW.indexOf('Run load scenario A'))
  })

  it('runs scenario A with fixed values and writes its result for the trend', () => {
    const run = stepWith('Run load scenario A')
    expect(run).toContain('npm run test:load:perf')
    expect(run).toContain("LOAD_VUS: '3'")
    expect(run).toContain("LOAD_DURATION_S: '30'")
    expect(run).toContain('LOAD_OUTPUT_FILE:')
    expect(stepWith('Append to the trend')).toContain('npm run perf:trend -- --file="$TREND_FILE" --result="$RUNNER_TEMP/perf.json"')
  })

  it('records the night even when scenario A failed, and still fails the job', () => {
    expect(stepWith('Run load scenario A')).toContain('continue-on-error: true')
    expect(stepWith('Commit updated trend data')).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/)
    expect(stepWith('Fail job if scenario A failed')).toContain("steps.perf.outcome == 'failure'")
  })
})
