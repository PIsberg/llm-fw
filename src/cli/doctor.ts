import fs from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../config/config.js'

/**
 * `llm-fw doctor` — diagnose whether the interception environment is set up
 * correctly and, for anything that isn't, print the exact command to fix it.
 *
 * The OS-touching probe (reading files, querying services, checking ports) is
 * kept separate from the pure `evaluateProbe` decision logic so the latter can
 * be unit-tested without spawning processes or depending on the host's state.
 */

export type OS = 'win32' | 'darwin' | 'linux'
export type CheckLevel = 'ok' | 'fail' | 'warn' | 'info'

export interface CheckResult {
  level: CheckLevel
  title: string
  detail?: string
  /** Commands / instructions to remediate, shown indented under the check. */
  fix?: string[]
}

/** A snapshot of the host facts the checks reason about. */
export interface DoctorProbe {
  os: OS
  proxyPort: number
  httpsPort: number
  dashboardPort: number
  mode: 'proxy' | 'sinkhole'
  /** True when sinkhole coverage is expected (config mode or hosts-file marker). */
  sinkholeActive: boolean
  caCertPath: string
  running: boolean
  pid: number | null
  caCertExists: boolean
  /** true = found in OS trust store, false = absent, null = couldn't determine. */
  caTrusted: boolean | null
  proxyListening: boolean
  dashboardListening: boolean
  sinkholeListening: boolean
  httpsProxyEnv: string | null
  nodeExtraCaCertsEnv: string | null
  /** Target provider hosts NOT redirected to 127.0.0.1 in the hosts file. */
  missingHostsTargets: string[]
  hostsTargetCount: number
  /** true = redirect rule present, false = absent, null = couldn't determine. */
  portRedirectPresent: boolean | null
  /** Windows only: IP Helper service running (required for portproxy). */
  iphlpsvcRunning: boolean | null
}

// ── pure helpers ────────────────────────────────────────────────────────────

function normalizeUrl(u: string | null): string {
  return (u ?? '').trim().replace(/\/+$/, '').toLowerCase()
}

function samePath(a: string, b: string, os: OS): boolean {
  const norm = (s: string) => s.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const x = norm(a)
  const y = norm(b)
  return os === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** Per-OS command to set an environment variable for the current session. */
export function setEnvCmd(os: OS, name: string, value: string): string {
  return os === 'win32'
    ? `$env:${name}="${value}"   # PowerShell (use setx for a permanent value)`
    : `export ${name}="${value}"`
}

function caTrustFix(os: OS, caCertPath: string): string {
  if (os === 'win32') return `certutil -addstore -f Root "${caCertPath}"   # run elevated`
  if (os === 'darwin') return `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${caCertPath}"`
  return `sudo cp "${caCertPath}" /usr/local/share/ca-certificates/llm-fw-ca.crt && sudo update-ca-certificates`
}

function elevatedSetup(os: OS): string {
  return os === 'win32'
    ? 'Run your terminal as Administrator, then: llm-fw setup'
    : 'sudo llm-fw setup'
}

function redirectName(os: OS, httpsPort: number): string {
  if (os === 'win32') return `netsh portproxy 127.0.0.1:443 → ${httpsPort}`
  if (os === 'darwin') return `pf rdr lo0:443 → ${httpsPort}`
  return `iptables REDIRECT :443 → ${httpsPort}`
}

function redirectShowCmd(os: OS): string {
  if (os === 'win32') return 'netsh interface portproxy show all'
  if (os === 'darwin') return 'sudo pfctl -s nat'
  return 'sudo iptables -t nat -S OUTPUT'
}

// ── pure evaluation ───────────────────────────────────────────────────────────

/**
 * Turn a host snapshot into an ordered list of check results. Mode-aware:
 * HTTPS_PROXY is required in proxy mode but optional under the sinkhole;
 * hosts-file / port-redirect / iphlpsvc checks only apply when the sinkhole
 * is active.
 */
export function evaluateProbe(p: DoctorProbe): CheckResult[] {
  const checks: CheckResult[] = []
  const proxyUrl = `http://127.0.0.1:${p.proxyPort}`

  // Process
  checks.push(p.running
    ? { level: 'ok', title: `llm-fw process running (PID ${p.pid ?? '?'})` }
    : { level: 'fail', title: 'llm-fw process not running', fix: ['llm-fw setup   # if not yet configured', 'llm-fw start'] })

  // CA certificate file
  checks.push(p.caCertExists
    ? { level: 'ok', title: 'CA certificate present', detail: p.caCertPath }
    : { level: 'fail', title: 'CA certificate missing', detail: p.caCertPath, fix: ['llm-fw setup'] })

  // CA in OS trust store
  if (p.caTrusted === true) checks.push({ level: 'ok', title: 'CA trusted in OS trust store' })
  else if (p.caTrusted === false) checks.push({ level: 'warn', title: 'CA not found in OS trust store', fix: [caTrustFix(p.os, p.caCertPath)] })
  else checks.push({ level: 'info', title: 'CA trust state could not be verified' })

  // Proxy / dashboard listeners (only meaningful when the process is up)
  if (p.running) {
    checks.push(p.proxyListening
      ? { level: 'ok', title: `Proxy listening on ${proxyUrl}` }
      : { level: 'fail', title: `Proxy NOT listening on 127.0.0.1:${p.proxyPort}`, fix: ['llm-fw start'] })
    checks.push(p.dashboardListening
      ? { level: 'ok', title: `Dashboard listening on http://127.0.0.1:${p.dashboardPort}` }
      : { level: 'warn', title: `Dashboard not listening on 127.0.0.1:${p.dashboardPort}` })
  }

  // HTTPS_PROXY — required in proxy mode, optional under the sinkhole
  const proxyEnvOk = normalizeUrl(p.httpsProxyEnv) === normalizeUrl(proxyUrl)
  if (proxyEnvOk) {
    checks.push({ level: 'ok', title: `HTTPS_PROXY = ${p.httpsProxyEnv}` })
  } else if (p.sinkholeActive) {
    checks.push({ level: 'info', title: 'HTTPS_PROXY not set (not required in sinkhole mode)' })
  } else {
    checks.push({
      level: 'fail',
      title: 'HTTPS_PROXY not pointing at the proxy',
      detail: p.httpsProxyEnv ? `current: ${p.httpsProxyEnv}` : 'unset',
      fix: [setEnvCmd(p.os, 'HTTPS_PROXY', proxyUrl)],
    })
  }

  // NODE_EXTRA_CA_CERTS — needed by Node.js clients (Claude Code, SDKs) in both modes
  const caEnvOk = !!p.nodeExtraCaCertsEnv && samePath(p.nodeExtraCaCertsEnv, p.caCertPath, p.os)
  if (caEnvOk) {
    checks.push({ level: 'ok', title: 'NODE_EXTRA_CA_CERTS set for Node.js tools', detail: p.nodeExtraCaCertsEnv ?? undefined })
  } else if (p.nodeExtraCaCertsEnv) {
    checks.push({
      level: 'warn',
      title: 'NODE_EXTRA_CA_CERTS does not point at the llm-fw CA',
      detail: `current:  ${p.nodeExtraCaCertsEnv}\nexpected: ${p.caCertPath}`,
      fix: [setEnvCmd(p.os, 'NODE_EXTRA_CA_CERTS', p.caCertPath)],
    })
  } else {
    checks.push({
      level: 'warn',
      title: 'NODE_EXTRA_CA_CERTS not set (required for Node.js clients: Claude Code, SDKs)',
      fix: [setEnvCmd(p.os, 'NODE_EXTRA_CA_CERTS', p.caCertPath)],
    })
  }

  // ── Sinkhole-only checks ────────────────────────────────────────────────────
  if (p.sinkholeActive) {
    // Hosts file entries
    if (p.missingHostsTargets.length === 0 && p.hostsTargetCount > 0) {
      checks.push({ level: 'ok', title: `Hosts file redirects ${p.hostsTargetCount} provider host(s) to 127.0.0.1` })
    } else if (p.hostsTargetCount > 0) {
      checks.push({
        level: 'fail',
        title: `Hosts file missing ${p.missingHostsTargets.length} provider entr${p.missingHostsTargets.length === 1 ? 'y' : 'ies'}`,
        detail: p.missingHostsTargets.slice(0, 6).join(', ') + (p.missingHostsTargets.length > 6 ? ', …' : ''),
        fix: [elevatedSetup(p.os)],
      })
    } else {
      checks.push({ level: 'fail', title: 'No llm-fw sinkhole entries in hosts file', fix: [elevatedSetup(p.os)] })
    }

    // Sinkhole TLS listener
    if (p.running) {
      checks.push(p.sinkholeListening
        ? { level: 'ok', title: `Sinkhole TLS server listening on 127.0.0.1:${p.httpsPort}` }
        : { level: 'fail', title: `Sinkhole TLS server NOT listening on 127.0.0.1:${p.httpsPort}`, fix: ['llm-fw start'] })
    }

    // Windows: IP Helper service is required for netsh portproxy to work
    if (p.os === 'win32') {
      if (p.iphlpsvcRunning === true) {
        checks.push({ level: 'ok', title: 'IP Helper service (iphlpsvc) running — required for portproxy' })
      } else if (p.iphlpsvcRunning === false) {
        checks.push({
          level: 'fail',
          title: 'IP Helper service (iphlpsvc) not running — portproxy cannot forward :443',
          fix: ['sc config iphlpsvc start= auto', 'net start iphlpsvc   # or: Start-Service iphlpsvc'],
        })
      } else {
        checks.push({ level: 'info', title: 'iphlpsvc state could not be determined', fix: ['Get-Service iphlpsvc'] })
      }
    }

    // OS-level :443 → httpsPort redirect
    const name = redirectName(p.os, p.httpsPort)
    if (p.portRedirectPresent === true) {
      checks.push({ level: 'ok', title: `Port redirect active (${name})` })
    } else if (p.portRedirectPresent === false) {
      checks.push({ level: 'fail', title: `Port redirect missing (${name})`, fix: [elevatedSetup(p.os)] })
    } else {
      checks.push({ level: 'info', title: `Port redirect state could not be determined (${name})`, fix: [redirectShowCmd(p.os)] })
    }
  }

  return checks
}

export function summarize(checks: CheckResult[]): { ok: number; fail: number; warn: number; info: number; healthy: boolean } {
  const count = (l: CheckLevel) => checks.filter(c => c.level === l).length
  const fail = count('fail')
  return { ok: count('ok'), fail, warn: count('warn'), info: count('info'), healthy: fail === 0 }
}

// ── OS-touching probe ─────────────────────────────────────────────────────────

function portListening(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ port, host })
    let done = false
    const finish = (v: boolean) => { if (!done) { done = true; sock.destroy(); resolve(v) } }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/** Run a command, returning stdout on success or null if it errors/missing. */
function safeExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function detectCaTrusted(os: OS): boolean | null {
  if (os === 'win32') {
    const out = safeExec('certutil', ['-store', 'Root'])
    return out === null ? null : /llm-fw Local CA/i.test(out)
  }
  if (os === 'darwin') {
    const out = safeExec('security', ['find-certificate', '-c', 'llm-fw Local CA', '/Library/Keychains/System.keychain'])
    return out === null ? false : /llm-fw Local CA/i.test(out)
  }
  // Linux: setup copies the CA here and runs update-ca-certificates.
  try { return fs.existsSync('/usr/local/share/ca-certificates/llm-fw-ca.crt') } catch { return null }
}

function detectIphlpsvc(): boolean | null {
  const out = safeExec('sc', ['query', 'iphlpsvc'])
  return out === null ? null : /\bRUNNING\b/i.test(out)
}

function detectPortRedirect(os: OS, httpsPort: number): boolean | null {
  if (os === 'win32') {
    const out = safeExec('netsh', ['interface', 'portproxy', 'show', 'all'])
    if (out === null) return null
    return out.includes('443') && out.includes(String(httpsPort))
  }
  if (os === 'darwin') {
    const out = safeExec('pfctl', ['-s', 'nat'])
    if (out === null) return null
    return /port\s*=?\s*443/.test(out) && out.includes(String(httpsPort))
  }
  const out = safeExec('iptables', ['-t', 'nat', '-S', 'OUTPUT'])
  if (out === null) return null
  return /--dport\s+443/.test(out) && new RegExp(`--to-ports?\\s+${httpsPort}`).test(out)
}

async function probe(): Promise<DoctorProbe> {
  const config = await loadConfig()
  const os = platform() as OS
  const llmfwDir = process.env.LLM_FW_DIR || join(homedir(), '.llm-fw')
  const caCertPath = join(llmfwDir, 'ca.crt')
  const pidFile = join(homedir(), '.llm-fw', 'llm-fw.pid')

  // Process liveness via the pid file (mirrors `status`/`stop`).
  let running = false
  let pid: number | null = null
  try {
    const raw = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    if (!isNaN(raw)) {
      pid = raw
      try { process.kill(raw, 0); running = true } catch { running = false }
    }
  } catch { /* no pid file */ }

  // Sinkhole is active if config says so OR the hosts file carries the marker
  // (covers an elevated setup whose user config.json wasn't written).
  const hostsPath = os === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts'
  let hostsText = ''
  try { hostsText = fs.readFileSync(hostsPath, 'utf8') } catch { /* unreadable */ }
  const sinkholeActive = config.proxy.mode === 'sinkhole' || hostsText.includes('# llm-fw sinkhole')

  // A target is "present" when mapped to loopback anywhere in the hosts file.
  const missingHostsTargets = config.targets.filter(
    t => !new RegExp(`^\\s*(127\\.0\\.0\\.1|::1)\\s+${t.replace(/[.]/g, '\\.')}\\s*$`, 'm').test(hostsText)
  )
  const hostsTargetCount = config.targets.length - missingHostsTargets.length

  const [proxyListening, dashboardListening, sinkholeListening] = await Promise.all([
    running ? portListening(config.proxy.port) : Promise.resolve(false),
    running ? portListening(config.dashboard.port) : Promise.resolve(false),
    running && sinkholeActive ? portListening(config.proxy.httpsPort) : Promise.resolve(false),
  ])

  const env = process.env
  return {
    os,
    proxyPort: config.proxy.port,
    httpsPort: config.proxy.httpsPort,
    dashboardPort: config.dashboard.port,
    mode: config.proxy.mode,
    sinkholeActive,
    caCertPath,
    running,
    pid,
    caCertExists: fs.existsSync(caCertPath),
    caTrusted: detectCaTrusted(os),
    proxyListening,
    dashboardListening,
    sinkholeListening,
    httpsProxyEnv: env['HTTPS_PROXY'] ?? env['https_proxy'] ?? null,
    nodeExtraCaCertsEnv: env['NODE_EXTRA_CA_CERTS'] ?? null,
    missingHostsTargets,
    hostsTargetCount,
    portRedirectPresent: sinkholeActive ? detectPortRedirect(os, config.proxy.httpsPort) : null,
    iphlpsvcRunning: sinkholeActive && os === 'win32' ? detectIphlpsvc() : null,
  }
}

// ── rendering ─────────────────────────────────────────────────────────────────

const useColor = !!process.stdout.isTTY && !process.env['NO_COLOR']
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const SYMBOL: Record<CheckLevel, string> = {
  ok: paint('32', '✓'),
  fail: paint('31', '✗'),
  warn: paint('33', '⚠'),
  info: paint('90', '•'),
}

function render(checks: CheckResult[]): void {
  for (const c of checks) {
    console.log(`  ${SYMBOL[c.level]} ${c.title}`)
    if (c.detail) for (const line of c.detail.split('\n')) console.log(`      ${paint('90', line)}`)
    if (c.fix && c.level !== 'ok') for (const f of c.fix) console.log(`      ${paint('36', '↳ ' + f)}`)
  }
}

export async function run(args: string[] = []): Promise<void> {
  const snapshot = await probe()
  const checks = evaluateProbe(snapshot)

  if (args.includes('--json')) {
    console.log(JSON.stringify({ probe: snapshot, checks, summary: summarize(checks) }, null, 2))
  } else {
    console.log('\nllm-fw doctor — environment diagnostics\n')
    console.log(`  Mode: ${snapshot.mode}${snapshot.sinkholeActive ? ' (sinkhole active)' : ''} · OS: ${snapshot.os}\n`)
    render(checks)
    const s = summarize(checks)
    console.log(`\n  ${s.ok} ok · ${s.warn} warning(s) · ${s.fail} problem(s)`)
    console.log(s.healthy
      ? `  ${SYMBOL.ok} Setup looks healthy.\n`
      : `  ${SYMBOL.fail} Setup has problems — see the ↳ fixes above.\n`)
  }

  process.exitCode = summarize(checks).healthy ? 0 : 1
}
