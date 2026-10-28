import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The v0.7.0 publish failed with `404 Not Found - PUT https://registry.npmjs.org/llm-fw`:
// the workflow authenticated with an NPM_TOKEN secret older than the 90-day cap
// on granular publish tokens. Publishing now uses npm Trusted Publishing (OIDC).
// That only works when the npm CLI is new enough (11.5.1+, and Node 22 bundles
// npm 10, which silently falls back to token auth) and the job may mint an OIDC
// token. These tests pin both, and that no stored token comes back.
//
// Asserted against the workflow text rather than a YAML parse, as in
// nightlyWorkflow.test.ts: the repo has no YAML dependency.
const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url)),
  'utf8',
)

/** The `- name:` step block that contains `needle`. */
function stepWith(needle: string): string | undefined {
  return WORKFLOW.split(/\n(?=\s*- name:)/).find(s => s.includes(needle))
}

/** True when `version` (x.y.z) is at least `min` (x.y.z). */
function atLeast(version: string, min: string): boolean {
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

describe('release workflow — npm Trusted Publishing', () => {
  it('lets the publish job mint an OIDC token', () => {
    expect(WORKFLOW).toMatch(/^\s*id-token:\s*write\b/m)
  })

  it('installs a pinned npm that supports Trusted Publishing before publishing', () => {
    const install = /npm install -g npm@(\d+\.\d+\.\d+)\b/.exec(WORKFLOW)
    // An exact pin: a floating `npm@latest` would let a new major change the
    // publish path on release day with nobody having reviewed it.
    expect(install).not.toBeNull()
    expect(atLeast(install![1], '11.5.1')).toBe(true)

    const publish = WORKFLOW.indexOf('npm publish')
    expect(publish).toBeGreaterThan(-1)
    expect(install!.index).toBeLessThan(publish)
  })

  it('passes no stored npm token to the publish step', () => {
    // npm prefers OIDC when it can get it, but a token here is a credential
    // that expires and fails the release with a misleading 404.
    expect(stepWith('npm publish')).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/)
    expect(WORKFLOW).not.toMatch(/secrets\.NPM_TOKEN/)
  })
})

// An SBOM on every release, so a customer can audit what a version ships
// without installing it. Its own job: uploading a release asset needs
// contents: write, and the publish job (which can mint an npm OIDC token)
// must not hold a write token as well.
describe('release workflow: SBOM', () => {
  /** The text of one job, from its key to the next top-level job key, without comments. */
  function job(name: string): string {
    const start = WORKFLOW.search(new RegExp(`^  ${name}:\\s*$`, 'm'))
    if (start === -1) return ''
    const rest = WORKFLOW.slice(start + 1)
    const next = rest.search(/^ {2}[a-z][\w-]*:\s*$/m)
    const text = next === -1 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, start + 1 + next)
    return text.split(/\r?\n/).filter(line => !line.trim().startsWith('#')).join('\n')
  }

  it('generates a CycloneDX SBOM of the production dependencies from the lockfile', () => {
    expect(job('sbom')).toMatch(/npm sbom --sbom-format cyclonedx --omit dev --package-lock-only/)
  })

  it('attaches it to the release that triggered the run, and only on a release', () => {
    const sbom = job('sbom')
    expect(sbom).toMatch(/gh release upload "\$GITHUB_REF_NAME"/)
    expect(sbom).toMatch(/if: github\.event_name == 'release'/)
    expect(sbom).toMatch(/needs: publish/)
  })

  it('is the only job with write access to the repository', () => {
    expect(job('sbom')).toMatch(/contents: write/)
    expect(job('publish')).not.toMatch(/contents: write/)
    expect(job('publish')).toMatch(/contents: read/)
  })
})
