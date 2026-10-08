import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Every other input to the supply chain here is pinned: actions by SHA, the
// Semgrep lock by hash, npm by lockfile. The Dockerfile's base image was pinned
// by tag only, so two builds of one commit could produce different images and
// a re-pushed tag would be picked up without a diff. OpenSSF Scorecard reported
// all three stages (code-scanning alerts #64-#66), and no Dependabot ecosystem
// proposed base-image updates either (#253).
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DOCKERFILE = readFileSync(`${ROOT}Dockerfile`, 'utf8')
const DEPENDABOT = readFileSync(`${ROOT}.github/dependabot.yml`, 'utf8')

/** The image reference of every FROM line, stage aliases stripped. */
const fromImages = (dockerfile: string): string[] =>
  [...dockerfile.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map((m) => m[1])

describe('Dockerfile base images', () => {
  const images = fromImages(DOCKERFILE)
  // Stage names reused as a base (`FROM build`) are not registry images.
  const stages = new Set([...DOCKERFILE.matchAll(/^FROM\s.+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase()))
  const external = images.filter((i) => !stages.has(i.toLowerCase()))

  it('has FROM lines at all', () => {
    expect(external.length).toBeGreaterThan(0)
  })

  it('pins every base image by digest, keeping the tag for readability', () => {
    for (const image of external) {
      expect(image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/)
    }
  })

  it('builds every stage from the same base', () => {
    // One digest moving without the others would build and run on different
    // Node and Debian patch levels.
    expect(new Set(external).size).toBe(1)
  })
})

describe('dependabot.yml', () => {
  it('watches the Dockerfile with the same cooldown as the other ecosystems', () => {
    const block = /- package-ecosystem: docker\n([\s\S]*?)(?=\n {2}- package-ecosystem:|\n\s*\n {2}#|$)/.exec(DEPENDABOT)?.[1]
    expect(block).toBeDefined()
    expect(block).toMatch(/directory: \/\n/)
    expect(block).toMatch(/default-days: 7/)
  })
})
