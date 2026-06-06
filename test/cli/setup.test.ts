import { describe, it, expect } from 'vitest'
import { addProfileEnvVars } from '../../src/cli/setup.js'
import { stripProfileEnvVars } from '../../src/cli/uninstall.js'

const PROXY = 'http://127.0.0.1:8080'

describe('addProfileEnvVars', () => {
  it('appends the llm-fw env block with both exports', () => {
    const out = addProfileEnvVars('export PATH=/bin\n', PROXY)
    expect(out).toContain('# llm-fw env')
    expect(out).toContain('export HTTPS_PROXY=http://127.0.0.1:8080')
    expect(out).toContain('export NODE_EXTRA_CA_CERTS="$HOME/.llm-fw/ca.crt"')
    // Pre-existing content is preserved.
    expect(out).toContain('export PATH=/bin')
  })

  it('is idempotent — running twice does not duplicate the block', () => {
    const once = addProfileEnvVars('export PATH=/bin\n', PROXY)
    const twice = addProfileEnvVars(once, PROXY)
    expect(twice).toBe(once)
    expect(twice.match(/# llm-fw env/g)?.length).toBe(1)
    expect(twice.match(/export HTTPS_PROXY=/g)?.length).toBe(1)
  })

  it('refreshes a stale proxy port instead of stacking a second export', () => {
    const old = addProfileEnvVars('', 'http://127.0.0.1:9999')
    const updated = addProfileEnvVars(old, PROXY)
    expect(updated.match(/export HTTPS_PROXY=/g)?.length).toBe(1)
    expect(updated).toContain('export HTTPS_PROXY=http://127.0.0.1:8080')
    expect(updated).not.toContain('9999')
  })

  it('leaves a user\'s own corporate proxy untouched', () => {
    const out = addProfileEnvVars('export HTTPS_PROXY=http://corp-proxy:3128\n', PROXY)
    expect(out).toContain('export HTTPS_PROXY=http://corp-proxy:3128')
    expect(out).toContain('export HTTPS_PROXY=http://127.0.0.1:8080')
  })

  it('round-trips: stripProfileEnvVars removes exactly what addProfileEnvVars wrote', () => {
    const base = 'export PATH=/bin\nexport EDITOR=vim'
    const withVars = addProfileEnvVars(base + '\n', PROXY)
    const stripped = stripProfileEnvVars(withVars).replace(/\n+$/, '')
    expect(stripped).not.toContain('llm-fw')
    expect(stripped).not.toContain('HTTPS_PROXY')
    expect(stripped).toContain('export PATH=/bin')
    expect(stripped).toContain('export EDITOR=vim')
  })
})
