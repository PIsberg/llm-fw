import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// CI ran only on ubuntu-latest, so behaviour that exists only on Windows was
// never exercised: the cmd.exe line `setup` prints (an it.runIf(win32) case
// that always skipped), Task Scheduler registration, TerminateProcess on
// `stop`, HKCU\Environment reads in `doctor`. Four such defects were found by
// hand in one live test (#323). This pins a Windows job that runs the CLI
// suite, where those runIf cases execute.
//
// Asserted against the workflow text, like nightlyWorkflow.test.ts: the repo
// has no YAML dependency.
const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
)

/** The text of one top-level job, from its key to the next job key. */
function job(yaml: string, name: string): string | undefined {
  const start = yaml.search(new RegExp(`^  ${name}:\\s*$`, 'm'))
  if (start < 0) return undefined
  const rest = yaml.slice(start + 1)
  const next = rest.search(/^  [a-z][\w-]*:\s*$/m)
  return next < 0 ? yaml.slice(start) : yaml.slice(start, start + 1 + next)
}

describe('CI — Windows CLI job (#323)', () => {
  const windows = job(WORKFLOW, 'windows-cli')

  it('exists and runs on a Windows runner', () => {
    expect(windows).toBeDefined()
    expect(windows).toMatch(/runs-on:\s*windows-latest/)
  })

  it('runs the CLI test suite', () => {
    expect(windows).toMatch(/vitest run test\/cli/)
  })

  it('smoke-tests Task Scheduler registration unelevated, and removes it', () => {
    expect(windows).toMatch(/install-service/)
    expect(windows).toMatch(/schtasks \/Query \/TN llm-fw/)
    expect(windows).toMatch(/uninstall-service/)
  })
})
