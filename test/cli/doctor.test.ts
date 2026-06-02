import { describe, it, expect } from 'vitest'
import { evaluateProbe, summarize, setEnvCmd, type DoctorProbe } from '../../src/cli/doctor.js'

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
