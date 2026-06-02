import { describe, it, expect } from 'vitest'
import {
  evaluateProbe,
  summarize,
  setEnvCmd,
  parseCaStorePresent,
  parseIphlpsvcRunning,
  parsePortRedirect,
  type DoctorProbe,
} from '../../src/cli/doctor.js'

/** A fully-healthy sinkhole probe on Windows; tests override single fields. */
function probe(overrides: Partial<DoctorProbe> = {}): DoctorProbe {
  return {
    os: 'win32',
    proxyPort: 8080,
    httpsPort: 8443,
    dashboardPort: 7731,
    mode: 'sinkhole',
    sinkholeActive: true,
    caCertPath: 'C:\\Users\\me\\.llm-fw\\ca.crt',
    running: true,
    pid: 4242,
    caCertExists: true,
    caTrusted: true,
    proxyListening: true,
    dashboardListening: true,
    sinkholeListening: true,
    httpsProxyEnv: 'http://127.0.0.1:8080',
    nodeExtraCaCertsEnv: 'C:\\Users\\me\\.llm-fw\\ca.crt',
    missingHostsTargets: [],
    hostsTargetCount: 12,
    portRedirectPresent: true,
    iphlpsvcRunning: true,
    ...overrides,
  }
}

const titles = (probeOverrides: Partial<DoctorProbe>) =>
  evaluateProbe(probe(probeOverrides)).map(c => c.title)
const find = (p: DoctorProbe, substr: string) =>
  evaluateProbe(p).find(c => c.title.includes(substr))

describe('evaluateProbe', () => {
  it('reports a fully healthy sinkhole setup with no failures', () => {
    const checks = evaluateProbe(probe())
    const s = summarize(checks)
    expect(s.fail).toBe(0)
    expect(s.healthy).toBe(true)
    expect(checks.every(c => c.level === 'ok' || c.level === 'info')).toBe(true)
  })

  it('fails when the process is not running and suggests setup/start', () => {
    const c = find(probe({ running: false, pid: null, proxyListening: false, sinkholeListening: false, dashboardListening: false }), 'process not running')
    expect(c?.level).toBe('fail')
    expect(c?.fix?.join(' ')).toContain('llm-fw start')
  })

  it('does not probe listeners when the process is down (no listener checks emitted)', () => {
    const t = titles({ running: false, pid: null, proxyListening: false, sinkholeListening: false })
    expect(t.some(x => x.includes('Proxy listening'))).toBe(false)
    expect(t.some(x => x.includes('Sinkhole TLS server'))).toBe(false)
  })

  describe('Windows iphlpsvc', () => {
    it('fails with the start commands when iphlpsvc is stopped', () => {
      const c = find(probe({ iphlpsvcRunning: false }), 'iphlpsvc')
      expect(c?.level).toBe('fail')
      expect(c?.fix?.join('\n')).toContain('net start iphlpsvc')
      expect(c?.fix?.join('\n')).toContain('sc config iphlpsvc start= auto')
    })

    it('ticks iphlpsvc when running', () => {
      expect(find(probe({ iphlpsvcRunning: true }), 'iphlpsvc')?.level).toBe('ok')
    })

    it('is not checked on non-Windows or in proxy mode', () => {
      // Linux is still sinkhole, but iphlpsvc is Windows-only.
      expect(titles({ os: 'linux' }).some(x => x.includes('iphlpsvc'))).toBe(false)
      expect(evaluateProbe(probe({ sinkholeActive: false, mode: 'proxy' })).some(c => c.title.includes('iphlpsvc'))).toBe(false)
    })
  })

  describe('HTTPS_PROXY (mode-aware)', () => {
    it('is required in proxy mode — fails when unset', () => {
      const c = find(probe({ mode: 'proxy', sinkholeActive: false, httpsProxyEnv: null }), 'HTTPS_PROXY')
      expect(c?.level).toBe('fail')
      expect(c?.fix?.[0]).toContain('HTTPS_PROXY')
    })

    it('is optional in sinkhole mode — only informational when unset', () => {
      expect(find(probe({ httpsProxyEnv: null }), 'HTTPS_PROXY')?.level).toBe('info')
    })

    it('ticks when set to the right proxy regardless of trailing slash', () => {
      expect(find(probe({ mode: 'proxy', sinkholeActive: false, httpsProxyEnv: 'http://127.0.0.1:8080/' }), 'HTTPS_PROXY')?.level).toBe('ok')
    })

    it('honors a non-default proxy port', () => {
      const c = find(probe({ mode: 'proxy', sinkholeActive: false, proxyPort: 9000, httpsProxyEnv: 'http://127.0.0.1:8080' }), 'HTTPS_PROXY')
      expect(c?.level).toBe('fail') // env points at the old port
      expect(c?.fix?.[0]).toContain('9000')
    })
  })

  describe('NODE_EXTRA_CA_CERTS', () => {
    it('warns when unset', () => {
      expect(find(probe({ nodeExtraCaCertsEnv: null }), 'NODE_EXTRA_CA_CERTS')?.level).toBe('warn')
    })

    it('matches the CA path case-insensitively / slash-insensitively on Windows', () => {
      const c = find(probe({ nodeExtraCaCertsEnv: 'c:/users/me/.llm-fw/ca.crt' }), 'NODE_EXTRA_CA_CERTS')
      expect(c?.level).toBe('ok')
    })

    it('warns when pointing at the wrong file', () => {
      expect(find(probe({ nodeExtraCaCertsEnv: 'C:\\other\\ca.crt' }), 'NODE_EXTRA_CA_CERTS')?.level).toBe('warn')
    })

    it('is case-sensitive on POSIX', () => {
      const c = find(probe({ os: 'linux', caCertPath: '/home/me/.llm-fw/ca.crt', nodeExtraCaCertsEnv: '/home/ME/.llm-fw/ca.crt' }), 'NODE_EXTRA_CA_CERTS')
      expect(c?.level).toBe('warn')
    })
  })

  describe('hosts file and port redirect (sinkhole)', () => {
    it('fails listing missing provider entries', () => {
      const c = find(probe({ missingHostsTargets: ['api.anthropic.com', 'api.openai.com'] }), 'Hosts file missing')
      expect(c?.level).toBe('fail')
      expect(c?.detail).toContain('api.anthropic.com')
      expect(c?.fix?.[0]).toContain('llm-fw setup')
    })

    it('fails when the port redirect is absent', () => {
      expect(find(probe({ portRedirectPresent: false }), 'Port redirect missing')?.level).toBe('fail')
    })

    it('is informational when the redirect state is indeterminate (not elevated)', () => {
      const c = find(probe({ portRedirectPresent: null }), 'Port redirect state could not be determined')
      expect(c?.level).toBe('info')
      expect(c?.fix?.[0]).toContain('portproxy show all')
    })

    it('skips all sinkhole checks in proxy-only mode', () => {
      const t = titles({ mode: 'proxy', sinkholeActive: false })
      expect(t.some(x => x.includes('Hosts file'))).toBe(false)
      expect(t.some(x => x.includes('Port redirect'))).toBe(false)
      expect(t.some(x => x.includes('Sinkhole TLS server'))).toBe(false)
    })
  })

  describe('CA trust', () => {
    it('warns with a per-OS install command when untrusted', () => {
      expect(find(probe({ os: 'darwin', caTrusted: false }), 'CA not found')?.fix?.[0]).toContain('security add-trusted-cert')
      expect(find(probe({ os: 'linux', caTrusted: false }), 'CA not found')?.fix?.[0]).toContain('update-ca-certificates')
      expect(find(probe({ os: 'win32', caTrusted: false }), 'CA not found')?.fix?.[0]).toContain('certutil -addstore')
    })

    it('is informational when trust cannot be determined', () => {
      expect(find(probe({ caTrusted: null }), 'CA trust state could not be verified')?.level).toBe('info')
    })
  })
})

describe('setEnvCmd', () => {
  it('emits PowerShell syntax on Windows and export on POSIX', () => {
    expect(setEnvCmd('win32', 'HTTPS_PROXY', 'http://127.0.0.1:8080')).toContain('$env:HTTPS_PROXY="http://127.0.0.1:8080"')
    expect(setEnvCmd('linux', 'HTTPS_PROXY', 'http://127.0.0.1:8080')).toBe('export HTTPS_PROXY="http://127.0.0.1:8080"')
  })
})

describe('summarize', () => {
  it('counts levels and is healthy only with zero failures', () => {
    const s = summarize([
      { level: 'ok', title: 'a' },
      { level: 'ok', title: 'b' },
      { level: 'warn', title: 'c' },
      { level: 'info', title: 'd' },
    ])
    expect(s).toMatchObject({ ok: 2, warn: 1, info: 1, fail: 0, healthy: true })
  })

  it('is unhealthy when any check fails (warnings alone do not)', () => {
    expect(summarize([{ level: 'warn', title: 'w' }]).healthy).toBe(true)
    expect(summarize([{ level: 'fail', title: 'f' }]).healthy).toBe(false)
  })
})

describe('parseIphlpsvcRunning (sc query iphlpsvc)', () => {
  const running = `
SERVICE_NAME: iphlpsvc
        TYPE               : 20  WIN32_SHARE_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)`
  const stopped = `
SERVICE_NAME: iphlpsvc
        TYPE               : 20  WIN32_SHARE_PROCESS
        STATE              : 1  STOPPED
        WIN32_EXIT_CODE    : 1077  (0x435)`

  it('detects the RUNNING state', () => {
    expect(parseIphlpsvcRunning(running)).toBe(true)
  })
  it('reports stopped as not running (the STOPPABLE hint must not count)', () => {
    expect(parseIphlpsvcRunning(stopped)).toBe(false)
  })
  it('handles empty/garbage output', () => {
    expect(parseIphlpsvcRunning('')).toBe(false)
  })
})

describe('parseCaStorePresent', () => {
  it('finds the llm-fw CA subject in a cert-store dump', () => {
    expect(parseCaStorePresent('================ Certificate 7 ================\nSubject: CN=llm-fw Local CA, O=llm-fw')).toBe(true)
  })
  it('returns false when the CA is absent', () => {
    expect(parseCaStorePresent('Subject: CN=DigiCert Global Root, O=DigiCert Inc')).toBe(false)
  })
})

describe('parsePortRedirect', () => {
  it('matches a Windows netsh portproxy row carrying both 443 and the https port', () => {
    const netsh = `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
127.0.0.1       443         127.0.0.1       8443
::1             443         127.0.0.1       8443`
    expect(parsePortRedirect('win32', netsh, 8443)).toBe(true)
    expect(parsePortRedirect('win32', netsh, 9999)).toBe(false) // wrong target port
    expect(parsePortRedirect('win32', '', 8443)).toBe(false)    // no rules
  })

  it('does not match when 443 and the https port are on unrelated rows (Windows)', () => {
    const split = `
127.0.0.1       443         127.0.0.1       5000
127.0.0.1       9000        127.0.0.1       8443`
    expect(parsePortRedirect('win32', split, 8443)).toBe(false)
  })

  it('matches a macOS pf rdr rule', () => {
    const pf = 'rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port = 443 -> 127.0.0.1 port 8443'
    expect(parsePortRedirect('darwin', pf, 8443)).toBe(true)
    expect(parsePortRedirect('darwin', pf, 8444)).toBe(false)
    expect(parsePortRedirect('darwin', 'No ALTQ support in kernel', 8443)).toBe(false)
  })

  it('matches a Linux iptables REDIRECT rule', () => {
    const ipt = '-A OUTPUT -o lo -p tcp -m tcp --dport 443 -j REDIRECT --to-ports 8443'
    expect(parsePortRedirect('linux', ipt, 8443)).toBe(true)
    expect(parsePortRedirect('linux', ipt, 8444)).toBe(false)
    expect(parsePortRedirect('linux', '-P OUTPUT ACCEPT', 8443)).toBe(false)
  })
})
