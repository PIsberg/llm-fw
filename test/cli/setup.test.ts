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

/**
 * `HTTPS_PROXY` is not selective and llm-fw does not implement `NO_PROXY`
 * server-side, so setup used to persist a proxy variable that routed *every*
 * HTTPS connection the machine made through the firewall — internal services,
 * package registries, loopback. Writing a companion `NO_PROXY` is the only
 * place llm-fw can address that, because the variable is honoured by the
 * client's HTTP stack rather than by the proxy.
 */
describe('addProfileEnvVars NO_PROXY companion', () => {
  it('writes a NO_PROXY alongside the proxy variable', () => {
    const out = addProfileEnvVars('', PROXY)
    expect(out).toContain('export NO_PROXY=')
  })

  it('excludes loopback, so a local call cannot be routed back into the proxy', () => {
    const out = addProfileEnvVars('', PROXY)
    const line = out.split('\n').find(l => l.startsWith('export NO_PROXY=')) ?? ''
    expect(line).toContain('localhost')
    expect(line).toContain('127.0.0.1')
    expect(line).toContain('::1')
  })

  it('is idempotent, like the rest of the block', () => {
    const once = addProfileEnvVars('export PATH=/bin\n', PROXY)
    const twice = addProfileEnvVars(once, PROXY)
    expect(twice).toBe(once)
    expect(twice.match(/export NO_PROXY=/g)?.length).toBe(1)
  })

  it('accepts extra exclusions from the caller', () => {
    const out = addProfileEnvVars('', PROXY, 'localhost,127.0.0.1,::1,.corp.internal')
    expect(out).toContain('.corp.internal')
  })

  it('leaves a user\'s own NO_PROXY untouched', () => {
    const out = addProfileEnvVars('export NO_PROXY=.mycompany.com\n', PROXY)
    expect(out).toContain('export NO_PROXY=.mycompany.com')
  })

  it('round-trips: uninstall strips the NO_PROXY it wrote', () => {
    const withVars = addProfileEnvVars('export PATH=/bin\n', PROXY)
    const stripped = stripProfileEnvVars(withVars)
    expect(stripped).not.toContain('NO_PROXY')
    expect(stripped).toContain('export PATH=/bin')
  })

  it('round-trips: uninstall keeps a NO_PROXY it did not write', () => {
    const profile = 'export NO_PROXY=.mycompany.com\n' + addProfileEnvVars('', PROXY)
    const stripped = stripProfileEnvVars(profile)
    expect(stripped).toContain('export NO_PROXY=.mycompany.com')
    expect(stripped).not.toContain('llm-fw')
  })
})
