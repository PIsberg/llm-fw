import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// `@stryker-mutator/vitest-runner` peer-depends on `@stryker-mutator/core` at an
// EXACT version. dependabot.yml leaves majors ungrouped, so the 10.0.0 majors
// arrived as two pull requests (#211 core, #212 vitest-runner), and each failed
// `npm ci` against the other package's old version: neither could ever go
// green alone (#252).
//
// The property pinned here is general rather than Stryker-specific: any two
// direct dependencies where one peer-depends on the other at an exact version
// must land in the same Dependabot group, and that group must take majors.
//
// Parsed textually, like nightlyWorkflow.test.ts: the repo has no YAML
// dependency and the npm block's group shape is small and regular.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DEPENDABOT = readFileSync(`${ROOT}.github/dependabot.yml`, 'utf8')
const PKG = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface Group {
  name: string
  patterns: string[]
  dependencyType?: string
  updateTypes?: string[]
}

/** The `groups:` of the npm ecosystem block, in declaration order. */
function npmGroups(yaml: string): Group[] {
  const block = /package-ecosystem: npm\n([\s\S]*?)(?=\n {2}- package-ecosystem:|\n {2}# |$)/.exec(yaml)?.[1] ?? ''
  const groupsBody = /\n {4}groups:\n([\s\S]*?)(?=\n {4}\S|$)/.exec(block)?.[1] ?? ''
  const groups: Group[] = []
  let current: Group | undefined
  let list: 'patterns' | 'updateTypes' | undefined
  for (const raw of groupsBody.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '')
    if (/^\s*(#.*)?$/.test(line)) continue
    const name = /^ {6}([\w-]+):\s*$/.exec(line)
    if (name) {
      current = { name: name[1], patterns: [] }
      groups.push(current)
      list = undefined
      continue
    }
    if (!current) continue
    const key = /^ {8}([\w-]+):\s*(\S*)\s*$/.exec(line)
    if (key) {
      list = undefined
      if (key[1] === 'patterns') { list = 'patterns' }
      else if (key[1] === 'update-types') { list = 'updateTypes'; current.updateTypes = [] }
      else if (key[1] === 'dependency-type') current.dependencyType = key[2]
      continue
    }
    const item = /^ {10}- '?([^']+?)'?\s*$/.exec(line)
    if (item && list === 'patterns') current.patterns.push(item[1])
    if (item && list === 'updateTypes') current.updateTypes!.push(item[1])
  }
  return groups
}

const globMatch = (pattern: string, name: string): boolean =>
  new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(name)

type UpdateType = 'major' | 'minor' | 'patch'

/** The group Dependabot files an update of `name` into: the first that matches. */
function groupFor(groups: Group[], name: string, isDev: boolean, update: UpdateType): string | undefined {
  return groups.find((g) => {
    if (g.updateTypes && !g.updateTypes.includes(update)) return false
    if (g.dependencyType === 'development' && !isDev) return false
    if (g.dependencyType === 'production' && isDev) return false
    return g.patterns.length === 0 || g.patterns.some((p) => globMatch(p, name))
  })?.name
}

/** Direct-dependency pairs [dependent, peer] with an exact-version peer pin. */
function exactPeerPairs(): Array<[string, string]> {
  const direct = { ...PKG.dependencies, ...PKG.devDependencies }
  const pairs: Array<[string, string]> = []
  for (const name of Object.keys(direct)) {
    const manifest = `${ROOT}node_modules/${name}/package.json`
    if (!existsSync(manifest)) continue
    const peers = (JSON.parse(readFileSync(manifest, 'utf8')) as { peerDependencies?: Record<string, string> })
      .peerDependencies ?? {}
    for (const [peer, range] of Object.entries(peers)) {
      if (peer in direct && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(range)) pairs.push([name, peer])
    }
  }
  return pairs
}

describe('dependabot.yml — peer-locked packages', () => {
  const groups = npmGroups(DEPENDABOT)
  const isDev = (name: string): boolean => name in (PKG.devDependencies ?? {})

  it('parses the npm groups at all', () => {
    // Guards the parser: an empty list would make every assertion below vacuous.
    expect(groups.map((g) => g.name)).toContain('dev-tooling')
  })

  it('finds the Stryker pair this was written for', () => {
    expect(exactPeerPairs()).toContainEqual(['@stryker-mutator/vitest-runner', '@stryker-mutator/core'])
  })

  it.each<UpdateType>(['major', 'minor', 'patch'])('puts every exact-peer pair in one group for %s updates', (update) => {
    for (const [dependent, peer] of exactPeerPairs()) {
      const a = groupFor(groups, dependent, isDev(dependent), update)
      const b = groupFor(groups, peer, isDev(peer), update)
      expect({ dependent, peer, group: a }).toEqual({ dependent, peer, group: expect.any(String) })
      expect({ dependent, peer, group: b }).toEqual({ dependent, peer, group: a })
    }
  })
})
