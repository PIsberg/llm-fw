import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// npm v12 stops running dependency install scripts by default (allowScripts
// off; #330). llm-fw depends on onnxruntime-node, whose postinstall fetches
// CUDA libraries on linux/x64. Nothing checked that llm-fw still installs and
// detects without it, so a CI job installs the packed tarball with
// --ignore-scripts and runs scripts/smoke-installed.mjs against it.
const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
)

function job(yaml: string, name: string): string | undefined {
  const start = yaml.search(new RegExp(`^  ${name}:\\s*$`, 'm'))
  if (start < 0) return undefined
  const rest = yaml.slice(start + 1)
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$/m)
  return next < 0 ? yaml.slice(start) : yaml.slice(start, start + 1 + next)
}

describe('CI — install without install scripts (#330)', () => {
  const smoke = job(WORKFLOW, 'install-no-scripts')

  it('installs the packed tarball on linux with scripts disabled', () => {
    expect(smoke).toBeDefined()
    expect(smoke).toMatch(/runs-on:\s*ubuntu-latest/)
    expect(smoke).toMatch(/npm pack/)
    expect(smoke).toMatch(/npm install --ignore-scripts/)
  })

  it('runs the detection smoke test against the installed copy', () => {
    expect(smoke).toMatch(/smoke-installed\.mjs/)
  })
})

// #584: npm 11.16+ warns at install time about every dependency whose install
// script is not covered by the root project's allowScripts, and npm 12 skips
// them. llm-fw needs none of them (the job above proves it on every PR), so
// each one is denied in package.json: a contributor's install is silent, and
// a new dependency that brings an install script fails here until someone
// decides. Measured 2026-10-31 with a packed install into a scratch project:
// the entries do not reach a consumer's install (npm reads allowScripts from
// the root project only, as it does overrides), so the README still tells
// users what they will be warned about and why it is safe.
describe('package.json allowScripts covers every install script in the lockfile (#584)', () => {
  const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
  const pkg = JSON.parse(readFileSync(root('package.json'), 'utf8')) as { allowScripts?: Record<string, boolean> }
  const lock = JSON.parse(readFileSync(root('package-lock.json'), 'utf8')) as { packages: Record<string, { hasInstallScript?: boolean }> }
  const withScripts = [...new Set(Object.entries(lock.packages)
    .filter(([path, v]) => path !== '' && v.hasInstallScript)
    .map(([path]) => path.replace(/^.*node_modules\//, '')))].sort()

  it('lists a decision for each dependency that has an install script', () => {
    expect(withScripts.length).toBeGreaterThan(0)
    const undecided = withScripts.filter(name => !(name in (pkg.allowScripts ?? {})))
    expect(undecided, 'add the package to allowScripts in package.json (false unless llm-fw needs its script)').toEqual([])
  })

  it('denies every one of them: llm-fw needs no install script', () => {
    for (const [name, allowed] of Object.entries(pkg.allowScripts ?? {})) expect(allowed, name).toBe(false)
  })

  it('keeps no entry for a package that has no install script any more', () => {
    // sharp has one for consumers (0.34.x, which the overrides do not reach), so it stays.
    const stale = Object.keys(pkg.allowScripts ?? {}).filter(name => name !== 'sharp' && !withScripts.includes(name))
    expect(stale).toEqual([])
  })
})
