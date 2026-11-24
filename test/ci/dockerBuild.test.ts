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

// #921: build arguments the Dockerfile documented but never let through.
describe('Dockerfile build arguments (#921)', () => {
  const stage = (name: string): string => {
    const df = read('Dockerfile')
    const start = df.indexOf(` AS ${name}\n`)
    const next = df.indexOf('\nFROM ', start + 1)
    return df.slice(start, next === -1 ? undefined : next)
  }

  it('the models stage declares LLM_FW_WARM_CLASSIFIER before it warms the models', () => {
    const models = stage('models')
    const arg = models.search(/^ARG LLM_FW_WARM_CLASSIFIER\b/m)
    expect(arg).toBeGreaterThan(-1)
    expect(arg).toBeLessThan(models.indexOf('RUN node docker/warm-models.mjs'))
  })

  it('the lean-ctx archive follows the image architecture unless LEAN_CTX_TARGET is set', () => {
    const leanctx = stage('leanctx')
    expect(leanctx).toMatch(/^ARG TARGETARCH$/m)
    expect(leanctx).not.toMatch(/^ARG LEAN_CTX_TARGET=x86_64/m)
    expect(leanctx).toMatch(/arm64\) LEAN_CTX_TARGET=aarch64-unknown-linux-gnu/)
  })
})
