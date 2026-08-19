import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseEnvOverrides, renderTable } from '../../scripts/gen-config-reference.js'

/**
 * The configuration guide promised "the full key reference" and listed four
 * environment variables while ENV_OVERRIDES held eighty-one. A hand-written
 * table of that size is a table that is wrong within a release, so it is
 * generated from the code and pinned here: adding a variable without running
 * `npm run config:reference` fails the build, which is also the moment the
 * documentation gets written.
 */
const root = join(fileURLToPath(new URL('../../', import.meta.url)))
const source = readFileSync(join(root, 'src', 'config', 'config.ts'), 'utf8')
const guide = readFileSync(join(root, 'docs', 'guides', 'configuration.md'), 'utf8')

describe('the configuration reference is generated from the code', () => {
  it('resolves a config key for every environment variable', () => {
    // An entry with no resolved key means the parser stopped understanding the
    // table's shape, which would silently publish a column of blanks.
    const unresolved = parseEnvOverrides(source).filter(e => !e.path)
    expect(unresolved.map(e => e.name)).toEqual([])
  })

  it('finds the variables that are known to exist', () => {
    const names = parseEnvOverrides(source).map(e => e.name)
    expect(names.length).toBeGreaterThan(50)
    expect(names).toContain('LLM_FW_PROXY_PORT')
    expect(names).toContain('LLM_FW_GATEWAY_TOKEN')
    // A multi-line entry: the parser reads the whole body, not one line.
    expect(parseEnvOverrides(source).find(e => e.name === 'LLM_FW_GATEWAY_TLS_CERT')?.path)
      .toBe('gateway.tls')
  })

  it('matches what is published in the guide', () => {
    expect(guide, 'run: npm run config:reference').toContain(renderTable(source))
  })

  it('does not document the provider keys, which are deliberately not in the config', () => {
    // LLM_FW_GATEWAY_KEY_<SLUG> is read straight from the environment so the
    // dashboard settings view cannot read a provider key back out. It has no
    // ENV_OVERRIDES entry and must not acquire one.
    expect(parseEnvOverrides(source).map(e => e.name).some(n => n.startsWith('LLM_FW_GATEWAY_KEY'))).toBe(false)
  })
})
