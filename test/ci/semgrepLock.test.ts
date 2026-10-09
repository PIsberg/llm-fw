import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The Semgrep lock used to live at .github/workflows/semgrep-requirements.txt.
// GitHub treats every file under .github/workflows/ as workflow content, and
// GITHUB_TOKEN can never be granted the `workflows` permission, so the weekly
// freshness job regenerated the lock correctly and then failed at the push,
// seven Mondays running (#251):
//
//   refusing to allow a GitHub App to create or update workflow
//   `.github/workflows/semgrep-requirements.txt` without `workflows` permission
//
// These tests pin the lock outside that directory and keep every reference to
// it pointing at the same file.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WORKFLOWS = `${ROOT}.github/workflows/`
const read = (rel: string): string => readFileSync(`${ROOT}${rel}`, 'utf8')

/** Every repo-relative path a workflow names as the Semgrep lock. */
function lockPaths(yaml: string): string[] {
  return [...yaml.matchAll(/(\.github\/[\w./-]*requirements\.txt)/g)].map((m) => m[1])
}

describe('Semgrep lock location', () => {
  it('keeps .github/workflows/ to workflow files only', () => {
    // Anything else in there is a file a workflow cannot push back.
    const stray = readdirSync(WORKFLOWS).filter((f) => !/\.ya?ml$/.test(f))
    expect(stray).toEqual([])
  })

  it('installs and regenerates the same lock, outside .github/workflows/', () => {
    const scan = lockPaths(read('.github/workflows/semgrep.yml'))
    const fresh = lockPaths(read('.github/workflows/semgrep-lock-freshness.yml'))
    // Both must name it at all, or the assertions below pass vacuously.
    expect(scan.length).toBeGreaterThan(0)
    expect(fresh.length).toBeGreaterThan(0)

    const paths = new Set([...scan, ...fresh])
    expect(paths.size).toBe(1)
    const [lock] = paths
    expect(lock.startsWith('.github/workflows/')).toBe(false)
    expect(existsSync(`${ROOT}${lock}`)).toBe(true)
  })

  it('documents its own regeneration target', () => {
    const scan = lockPaths(read('.github/workflows/semgrep.yml'))
    const lock = scan[0]
    expect(read(lock)).toContain(`-o ${lock}`)
  })
})
