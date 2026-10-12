import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'
import { addProfileEnvVars, caTrustHint, coverageLines, loadEnvCommands } from '../../src/cli/setup.js'
import { stripProfileEnvVars } from '../../src/cli/uninstall.js'

const PROXY = 'http://127.0.0.1:8080'

/**
 * Printed when setup cannot install the CA, which on Windows is every
 * non-elevated run. It used to list the Windows, macOS and Linux commands on
 * every OS, without saying the Windows one needs an Administrator terminal.
 */
describe('caTrustHint', () => {
  const ca = 'C:\\Users\\u\\.llm-fw\\ca.crt'

  it('on Windows gives only the certutil command and says it needs elevation', () => {
    const text = caTrustHint('win32', ca).join('\n')
    expect(text).toContain(`certutil -addstore -f Root "${ca}"`)
    expect(text).toMatch(/Administrator/)
    expect(text).not.toContain('security add-trusted-cert')
    expect(text).not.toContain('update-ca-certificates')
  })

  it('says Node.js tools already trust the CA through NODE_EXTRA_CA_CERTS', () => {
    expect(caTrustHint('win32', ca).join('\n')).toContain('NODE_EXTRA_CA_CERTS')
  })

  it('on macOS and Linux gives only that OS\'s sudo command', () => {
    const mac = caTrustHint('darwin', '/Users/u/.llm-fw/ca.crt').join('\n')
    expect(mac).toContain('sudo security add-trusted-cert')
    expect(mac).not.toContain('certutil')
    const linux = caTrustHint('linux', '/home/u/.llm-fw/ca.crt').join('\n')
    expect(linux).toContain('sudo update-ca-certificates')
    expect(linux).not.toContain('certutil')
  })
})

/**
 * The lines setup prints for loading the proxy variables into an already-open
 * terminal. The Command Prompt line used to join its two `set` commands with
 * `^&`, an ESCAPED ampersand: cmd then set HTTPS_PROXY to the whole rest of the
 * line ("http://127.0.0.1:8080 & set NODE_EXTRA_CA_CERTS=...") and never set
 * NODE_EXTRA_CA_CERTS at all, so the pasted line broke every client.
 */
describe('loadEnvCommands', () => {
  const ca = 'C:\\Users\\u\\.llm-fw\\ca.crt'
  const cmdLine = (): string => {
    const line = loadEnvCommands('win32', PROXY, ca).find(l => l.includes('Command Prompt:'))
    if (!line) throw new Error('no Command Prompt line')
    return line.slice(line.indexOf('Command Prompt:') + 'Command Prompt:'.length).trim()
  }

  it('joins the Command Prompt sets with a real &, each assignment quoted', () => {
    expect(cmdLine()).toBe(`set "HTTPS_PROXY=${PROXY}" & set "NODE_EXTRA_CA_CERTS=${ca}"`)
  })

  it.runIf(platform() === 'win32')('sets both variables when cmd.exe runs the printed line', () => {
    const env = { ...process.env }
    delete env.HTTPS_PROXY
    delete env.NODE_EXTRA_CA_CERTS
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${cmdLine()} & set HTTPS_PROXY & set NODE_EXTRA_CA_CERTS"`], {
      env, encoding: 'utf8', windowsVerbatimArguments: true,
    })
    const vars = r.stdout.split(/\r?\n/).map(l => l.trimEnd())
    expect(vars).toContain(`HTTPS_PROXY=${PROXY}`)
    expect(vars).toContain(`NODE_EXTRA_CA_CERTS=${ca}`)
  })

  it('gives PowerShell on Windows and a single export elsewhere', () => {
    expect(loadEnvCommands('win32', PROXY, ca).join('\n'))
      .toContain(`$env:HTTPS_PROXY="${PROXY}"; $env:NODE_EXTRA_CA_CERTS="${ca}"`)
    expect(loadEnvCommands('linux', PROXY, '/home/u/.llm-fw/ca.crt'))
      .toEqual([`    export HTTPS_PROXY=${PROXY} NODE_EXTRA_CA_CERTS="/home/u/.llm-fw/ca.crt"`])
  })
})

/**
 * The Coverage summary at the end of setup. Run unelevated with --proxy-only it
 * claimed curl and Python were covered while the CA had just failed to install
 * (they reject llm-fw's certificate), and said Node.js tools needed the
 * sinkhole while Claude Code, which honours HTTPS_PROXY, was covered already.
 */
describe('coverageLines', () => {
  const proxyOnly = { sinkhole: false, sinkholeWanted: false, elevated: false }

  it('names Claude Code among the HTTPS_PROXY tools the proxy covers', () => {
    expect(coverageLines({ ...proxyOnly, caTrusted: true }).join('\n')).toMatch(/Proxy mode .*Claude Code/)
  })

  it('does not say a skipped sinkhole leaves Claude Code uncovered', () => {
    for (const opts of [proxyOnly, { sinkhole: false, sinkholeWanted: true, elevated: false }]) {
      const rest = coverageLines({ ...opts, caTrusted: true }).filter(l => !l.includes('Proxy mode')).join('\n')
      expect(rest).not.toMatch(/Claude Code/)
      expect(rest).toMatch(/ignore HTTPS_PROXY/)
    }
  })

  it('warns that non-Node tools reject the certificate when the CA is not trusted', () => {
    const text = coverageLines({ ...proxyOnly, caTrusted: false }).join('\n')
    expect(text).toMatch(/CA not in the OS trust store/)
    expect(text).toMatch(/curl/)
    expect(text).toContain('NODE_EXTRA_CA_CERTS')
  })

  it('says nothing about trust when the CA was installed', () => {
    expect(coverageLines({ ...proxyOnly, caTrusted: true }).join('\n')).not.toMatch(/trust store/)
  })
})

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
