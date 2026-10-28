import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The container image is published to GHCR on a release, multi-arch, with
// provenance and an SBOM. Publishing can only happen on a release, so the same
// multi-arch build runs without pushing on every pull request that touches the
// image inputs: a Dockerfile change that breaks arm64 fails there, not on
// release day. Asserted against the workflow text, as the other CI tests are.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WORKFLOW = '.github/workflows/image.yml'
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8').replace(/\r\n/g, '\n')

/** One job's text, from its key to the next top-level job key, without comments. */
function job(wf: string, name: string): string {
  const start = wf.search(new RegExp(`^  ${name}:\\s*$`, 'm'))
  if (start === -1) return ''
  const rest = wf.slice(start + 1)
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$/m)
  const text = next === -1 ? wf.slice(start) : wf.slice(start, start + 1 + next)
  return text.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
}

describe('container image workflow', () => {
  it('exists', () => {
    expect(existsSync(`${ROOT}${WORKFLOW}`)).toBe(true)
  })

  it('builds both architectures without pushing on pull requests that touch the image', () => {
    const wf = read(WORKFLOW)
    const pr = wf.slice(wf.indexOf('pull_request:'), wf.indexOf('release:'))
    for (const path of ['Dockerfile', 'docker/**', 'package.json', 'package-lock.json']) expect(pr, path).toContain(`'${path}'`)
    const build = job(wf, 'build')
    expect(build).toMatch(/if: github\.event_name == 'pull_request'/)
    expect(build).toMatch(/platforms: linux\/amd64,linux\/arm64/)
    expect(build).toMatch(/push: false/)
  })

  it('pushes to ghcr.io/pisberg/llm-fw with provenance and an SBOM only on a published release', () => {
    const wf = read(WORKFLOW)
    expect(wf).toMatch(/release:\n\s+types: \[published\]/)
    const publish = job(wf, 'publish')
    expect(publish).toMatch(/if: github\.event_name == 'release'/)
    expect(publish).toMatch(/platforms: linux\/amd64,linux\/arm64/)
    expect(publish).toMatch(/push: true/)
    expect(publish).toContain('ghcr.io/pisberg/llm-fw:')
    expect(publish).toMatch(/provenance: mode=max/)
    expect(publish).toMatch(/sbom: true/)
  })

  it('gives write access to packages in the publish job only', () => {
    const wf = read(WORKFLOW)
    expect(job(wf, 'publish')).toMatch(/packages: write/)
    expect(job(wf, 'build')).not.toMatch(/: write/)
    // Nothing above the jobs grants write.
    expect(wf.slice(0, wf.indexOf('jobs:'))).not.toMatch(/: write/)
  })

  it('pins every action to a full commit SHA', () => {
    const uses = [...read(WORKFLOW).matchAll(/uses: ([^\s#]+)/g)].map(m => m[1]!)
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/)
  })

  it('is the image the Helm chart installs by default', () => {
    expect(read('deploy/helm/llm-fw/values.yaml')).toMatch(/^\s+repository: ghcr\.io\/pisberg\/llm-fw(\s+#.*)?$/m)
  })
})
