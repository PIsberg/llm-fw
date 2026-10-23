import { describe, it, expect } from 'vitest'
import { nodeRuntimeAdvisory, PATCHED_NODE } from '../../src/cli/nodeAdvisory.js'

/**
 * The proxy brotli-decompresses every upstream response it inspects
 * (`decompressBody` in src/proxy/proxy.ts), so the October 2026 Node.js
 * security release (CVE-2026-111497, an out-of-bounds write in the Brotli
 * decoder reachable from malformed input) is reachable from a provider
 * response. `engines.node >=22` cannot say "22, but at least 22.23.4", and
 * npm only warns about engines anyway, so the process says it at startup and
 * `llm-fw doctor` repeats it.
 */
describe('nodeRuntimeAdvisory', () => {
  it('is silent on the patched release of every supported line', () => {
    for (const v of Object.values(PATCHED_NODE)) {
      expect(nodeRuntimeAdvisory(`v${v}`)).toBeNull()
      expect(nodeRuntimeAdvisory(v)).toBeNull()
    }
  })

  it('is silent on later patches and later lines', () => {
    expect(nodeRuntimeAdvisory('v24.22.2')).toBeNull()
    expect(nodeRuntimeAdvisory('v24.23.0')).toBeNull()
    expect(nodeRuntimeAdvisory('v28.0.0')).toBeNull()
  })

  it('names the patched version and the CVE when the line is behind', () => {
    const msg = nodeRuntimeAdvisory('v26.8.2')
    expect(msg).toContain('26.8.2')
    expect(msg).toContain('26.12.1')
    expect(msg).toContain('CVE-2026-111497')
    expect(nodeRuntimeAdvisory('v22.23.3')).toContain('22.23.4')
    expect(nodeRuntimeAdvisory('v24.0.0')).toContain('24.22.1')
  })

  it('says an end-of-life line gets no fix at all', () => {
    expect(nodeRuntimeAdvisory('v25.9.0')).toMatch(/end-of-life/)
    expect(nodeRuntimeAdvisory('v23.11.0')).toMatch(/end-of-life/)
    expect(nodeRuntimeAdvisory('v20.19.0')).toMatch(/end-of-life/)
  })

  it('ignores a version it cannot parse', () => {
    expect(nodeRuntimeAdvisory('garbage')).toBeNull()
  })
})
