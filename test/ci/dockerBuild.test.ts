import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// No workflow built the Dockerfile, so a base-image bump merged on a green CI
// that never built or ran the image: #280 moved every stage to node:23 that
// way, and dependabot.yml's "build the image and run it once before merging"
// was a step nothing enforced (#299).
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WORKFLOW = '.github/workflows/docker.yml'
// CRLF folded so the line-anchored patterns hold on a Windows checkout (#283).
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8').replace(/\r\n/g, '\n')

describe('Docker image CI job', () => {
  it('exists', () => {
    expect(existsSync(`${ROOT}${WORKFLOW}`)).toBe(true)
  })

  it('runs on pull requests that touch the image inputs, Dependabot docker bumps included', () => {
    const wf = read(WORKFLOW)
    const pr = wf.slice(wf.indexOf('pull_request:'))

    for (const path of ['Dockerfile', 'docker/**', 'package.json', 'package-lock.json']) {
      expect(pr, path).toContain(`'${path}'`)
    }
  })

  it('builds the image', () => {
    expect(read(WORKFLOW)).toMatch(/^\s+run: .*docker build\b/m)
  })

  it('starts the container and waits for the gateway to report ready', () => {
    const wf = read(WORKFLOW)

    expect(wf).toMatch(/docker run\b[^\n]*LLM_FW_GATEWAY_TOKEN/)
    expect(wf).toContain('/readyz')
  })

  it('checks the Node major inside the image against the CI matrix', () => {
    // dockerPinning.test.ts checks the tag statically; this checks what the
    // built image actually runs.
    const wf = read(WORKFLOW)

    expect(wf).toMatch(/docker run\b[^\n]*--entrypoint node\b[^\n]*--version/)
    expect(wf).toContain('.github/workflows/ci.yml')
  })
})
