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
