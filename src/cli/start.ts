import { loadConfig } from '../config/config.js';
import { Config } from '../types.js';
import { ProxyServer } from '../proxy/proxy.js';
import { CertFactory } from '../proxy/certs.js';
import { createDashboardServer } from '../dashboard/server.js';
import { EventBus } from '../dashboard/eventBus.js';
import { MetricsRegistry } from '../dashboard/metrics.js';
import { Pipeline } from '../detection/pipeline.js';
import { SuppressionStore } from '../detection/suppressions.js';
import { startConfigHotReload } from '../config/hotReload.js';
import forge from 'node-forge';
import fs from 'node:fs';
import { join } from 'node:path';
import { platform, networkInterfaces } from 'node:os';
import { getLlmFwDir } from '../config/paths.js';
import { execSync, execFileSync } from 'node:child_process';

/**
 * True when the `start` args request shared-server mode. `--standalone` is the
 * canonical spelling; `--stand-alone` is accepted as an alias.
 */
export function isStandalone(args: string[]): boolean {
  return args.includes('--standalone') || args.includes('--stand-alone');
}

/**
 * Apply standalone-server overrides in place: force forward-proxy mode and bind
 * the proxy + dashboard to all interfaces so remote clients can reach them.
 * Explicit LLM_FW_*_BIND env vars take precedence over the 0.0.0.0 default.
 */
export function applyStandaloneOverrides(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): void {
  config.proxy.mode = 'proxy';
  if (!env['LLM_FW_PROXY_BIND']) config.proxy.bindHost = '0.0.0.0';
  if (!env['LLM_FW_DASHBOARD_BIND']) config.dashboard.bindHost = '0.0.0.0';
}

/** Best-effort primary non-internal IPv4 address, for printing client setup hints. */
export function lanIPv4(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '<this-server-ip>';
}

async function waitForPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
  const { createServer } = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>(resolve => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, () => srv.close(() => resolve(true)));
    });
    if (free) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function killPortOwner(port: number): void {
  try {
    if (platform() === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const line of out.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (m && parseInt(m[1], 10) === port) {
          const pid = parseInt(m[2], 10);
          if (pid && pid !== process.pid) try { process.kill(pid) } catch { }
        }
      }
    } else {
      // execFileSync (no shell) so the port can never be interpreted as a command.
      const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const pidStr of out.trim().split('\n')) {
        const pid = parseInt(pidStr, 10);
        if (pid && pid !== process.pid) try { process.kill(pid) } catch { }
      }
    }
  } catch { /* command unavailable */ }
}

export async function run(args: string[] = []): Promise<void> {
  const standalone = isStandalone(args);
  const config = await loadConfig();

  // Standalone server mode: expose the proxy (and dashboard/CA download) on all
  // interfaces so other machines on the network can route their LLM traffic
  // through this host. The sinkhole (local hosts-file redirect) is irrelevant
  // here — remote clients reach us purely as a forward HTTPS proxy — so it is
  // force-disabled below.
  if (standalone) applyStandaloneOverrides(config);

  const llmfwDir = getLlmFwDir();
  const pidFile = join(llmfwDir, 'llm-fw.pid');

  // Stop any already-running instance. Use SIGKILL (not SIGTERM) so the old
  // process's cleanup handler does NOT run — this preserves hosts file entries
  // and port-redirect rules so the new instance inherits them without needing
  // admin rights to re-create them.
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!isNaN(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    try { fs.unlinkSync(pidFile); } catch { }
  }
  for (const port of [config.proxy.port, config.dashboard.port]) {
    if (await waitForPortFree(port, 500)) continue;
    console.log(`Port ${port} still in use — killing owner...`);
    killPortOwner(port);
    if (!await waitForPortFree(port)) {
      console.error(`Port ${port} could not be freed. Kill the process manually and retry.`);
      process.exit(1);
    }
  }
  const hostsPath = platform() === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';

  // Also detect sinkhole from hosts file — covers the case where setup ran as
  // admin but config.json wasn't written (e.g. npm not in elevated PATH).
  const hostsHasSinkhole = (() => {
    try { return fs.readFileSync(hostsPath, 'utf8').includes('# llm-fw sinkhole'); }
    catch { return false; }
  })();
  // In standalone mode the sinkhole is meaningless (it redirects 127.0.0.1 on
  // THIS host, not the remote clients), so never activate it.
  const sinkholeActive = !standalone && (config.proxy.mode === 'sinkhole' || hostsHasSinkhole);

  // Re-apply sinkhole infrastructure if it was removed by the previous stop.
  // This makes every `start` self-healing: hosts entries and port redirect are
  // restored automatically so the user never needs to re-run setup after restart.
  if (sinkholeActive) {
    try {
      const hostsContent = fs.readFileSync(hostsPath, 'utf8');
      if (!hostsContent.includes('# llm-fw sinkhole')) {
        const backup = hostsPath + '.llm-fw.bak';
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, hostsContent, 'utf8');
        const hostLines = config.targets.map((t: string) => `127.0.0.1 ${t}`).join('\n');
        fs.appendFileSync(hostsPath, `\n# llm-fw sinkhole\n${hostLines}\n`, 'utf8');
      }
    } catch { /* no write access — hosts file already has entries or admin needed */ }

    const os = platform();
    if (os === 'win32') {
      try {
        execSync('sc config iphlpsvc start= auto', { stdio: 'ignore' });
        execSync('net start iphlpsvc', { stdio: 'ignore' });
      } catch { /* no admin rights or already running */ }
      try {
        const existingV4 = execSync('netsh interface portproxy show v4tov4', { encoding: 'utf8' });
        if (!existingV4.includes('443')) {
          execFileSync('netsh', [
            'interface', 'portproxy', 'add', 'v4tov4',
            'listenport=443', 'listenaddress=127.0.0.1',
            `connectport=${config.proxy.httpsPort}`, 'connectaddress=127.0.0.1',
          ], { stdio: 'ignore' });
        }
        const existingV6 = execSync('netsh interface portproxy show v6tov4', { encoding: 'utf8' });
        if (!existingV6.includes('443')) {
          execFileSync('netsh', [
            'interface', 'portproxy', 'add', 'v6tov4',
            'listenport=443', 'listenaddress=::1',
            `connectport=${config.proxy.httpsPort}`, 'connectaddress=127.0.0.1',
          ], { stdio: 'ignore' });
        }
      } catch { /* no admin rights */ }
    } else if (os === 'darwin') {
      try { execSync(`echo "rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${config.proxy.httpsPort}" | pfctl -ef -`, { stdio: 'pipe' }); } catch { }
    } else {
      try { execSync(`iptables -t nat -A OUTPUT -o lo -p tcp --dport 443 -j REDIRECT --to-port ${config.proxy.httpsPort} 2>/dev/null || true`, { stdio: 'pipe' }); } catch { }
    }
  }

  function restoreHostsFile(): void {
    const backup = hostsPath + '.llm-fw.bak';
    if (fs.existsSync(backup)) {
      try {
        const original = fs.readFileSync(backup, 'utf8');
        fs.writeFileSync(hostsPath, original, 'utf8');
        fs.unlinkSync(backup);
        console.log('Hosts file restored.');
      } catch (err) {
        console.error('Failed to restore hosts file:', (err as Error).message);
      }
    }
  }

  function cleanup(): void {
    if (sinkholeActive) {
      restoreHostsFile();
      const os = platform();
      if (os === 'win32') {
        try {
          execFileSync('netsh', [
            'interface', 'portproxy', 'delete', 'v4tov4',
            'listenport=443', 'listenaddress=127.0.0.1',
          ], { stdio: 'ignore' });
        } catch { }
        try {
          execFileSync('netsh', [
            'interface', 'portproxy', 'delete', 'v6tov4',
            'listenport=443', 'listenaddress=::1',
          ], { stdio: 'ignore' });
        } catch { }
      } else if (os === 'darwin') {
        try { execSync('pfctl -F nat', { stdio: 'ignore' }); } catch { }
      } else {
        try {
          execSync(
            `iptables -t nat -D OUTPUT -o lo -p tcp --dport 443 -j REDIRECT --to-port ${config.proxy.httpsPort}`,
            { stdio: 'ignore' }
          );
        } catch { }
      }
    }
    try {
      fs.unlinkSync(pidFile);
    } catch { }
  }

  // Register cleanup hooks before any IO. SIGINT/SIGTERM are the graceful
  // paths, so they also terminate the shared inference worker thread (Task
  // C3, detection.workerInference) if one was ever spawned — a no-op
  // otherwise. uncaughtException exits immediately without waiting on it;
  // the worker thread dies with the process either way.
  process.on('SIGINT', () => { hotReload.stop(); cleanup(); void pipeline.close().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { hotReload.stop(); cleanup(); void pipeline.close().finally(() => process.exit(0)); });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanup();
    process.exit(1);
  });

  // Write PID file
  fs.mkdirSync(llmfwDir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');

  // Task C4 — shared across the dashboard's EventBus (records block/warn/
  // event counters from the same hook that emits dashboard events) and both
  // Pipeline instances' run() call boundaries (proxy live traffic +
  // dashboard playground), so GET /metrics reports on the whole process.
  const metrics = new MetricsRegistry();
  const eventBus = new EventBus(config.dashboard, metrics);
  // Shared across the dashboard's playground pipeline and the proxy's live-
  // traffic pipeline (constructed below) so an operator marking a false
  // positive from the dashboard actually suppresses future real traffic —
  // not just the dashboard's own /api/test calls.
  const suppressions = new SuppressionStore();
  const pipeline = new Pipeline(config, (partial) => eventBus.emit(partial), suppressions);

  // Task C5 — watches <getLlmFwDir()>/config.json and hot-applies detection/
  // dlp/dos/rag/mcp/nonText/manyShot/crescendo/indirectInstruction/
  // harmfulRequest/responseScan toggles+thresholds onto this SAME `config`
  // object (shared by pipeline/proxy/dashboard below) with no restart. Cold
  // keys (ports/binds/mode/targets/interceptDomains) are logged as
  // restart-required and left untouched. On by default (config.hotReload,
  // env LLM_FW_HOT_RELOAD); stopped on graceful shutdown below.
  const hotReload = startConfigHotReload(config);

  // Auto-upgrade CA cert if it lacks a CRL Distribution Point (fixes Windows Schannel).
  const caCertPath = join(llmfwDir, 'ca.crt');
  if (fs.existsSync(caCertPath)) {
    const certPem = fs.readFileSync(caCertPath, 'utf8');
    const caCert = forge.pki.certificateFromPem(certPem);
    const hasCdp = (caCert.extensions as { id?: string }[]).some(e => e.id === '2.5.29.31');
    if (!hasCdp) {
      console.log('Upgrading CA cert (adding CRL distribution point)...');
      const cf = new CertFactory();
      cf.generateCA();
      cf.generateAndSaveCRL();
      if (platform() === 'win32') {
        try {
          execSync(`certutil -addstore -f Root "${caCertPath}"`, { stdio: 'ignore' });
          console.log('CA cert reinstalled to OS trust store.');
        } catch { console.warn('Could not reinstall CA cert — re-run "llm-fw setup" as admin.'); }
      }
    } else {
      const crlPath = join(llmfwDir, 'ca.crl');
      if (!fs.existsSync(crlPath)) new CertFactory().generateAndSaveCRL();
    }
  }

  console.log('Loading embedding model...');
  await pipeline.init();
  console.log('Model ready.');

  const dashboardServer = createDashboardServer(config, eventBus, pipeline, suppressions, metrics);
  dashboardServer.listen(config.dashboard.port, config.dashboard.bindHost, () => {
    // listening
  });

  const proxy = new ProxyServer(config, eventBus, suppressions, metrics);
  await proxy.init();
  proxy.start();

  if (config.proxy.bypass) {
    console.log('');
    console.log('  ⚠⚠⚠ FAIL-SAFE BYPASS ACTIVE (LLM_FW_BYPASS=true) ⚠⚠⚠');
    console.log('  The proxy is a TRANSPARENT TUNNEL: no interception, no detection,');
    console.log('  no blocking. All traffic passes through uninspected. Unset');
    console.log('  LLM_FW_BYPASS and restart to re-enable the firewall.');
    console.log('');
  }

  if (sinkholeActive) {
    proxy.startSinkhole(config.proxy.httpsPort);
    console.log(`  Sinkhole TLS: 127.0.0.1:${config.proxy.httpsPort} (via portproxy → :443)`);
  }

  if (standalone) {
    const ip = lanIPv4();
    console.log(`llm-fw running in STANDALONE server mode.`);
    console.log(`  Proxy:      http://${ip}:${config.proxy.port}  (listening on ${config.proxy.bindHost}:${config.proxy.port})`);
    console.log(`  Dashboard:  http://${ip}:${config.dashboard.port}`);
    console.log('');
    console.log('  Configure each client machine:');
    console.log(`    1. Download & trust the CA cert:  http://${ip}:${config.dashboard.port}/ca.crt?download`);
    console.log(`       (install into the OS / browser "Trusted Root" store)`);
    console.log(`    2. Point tools at the proxy:`);
    console.log(`         export HTTPS_PROXY=http://${ip}:${config.proxy.port}`);
    console.log(`         export HTTP_PROXY=http://${ip}:${config.proxy.port}`);
    console.log('');
    console.log('  ⚠ Security: the proxy is reachable by any host that can route to this');
    console.log('    machine. Run it only on a trusted network, or restrict access with a');
    console.log('    firewall rule. To keep the dashboard local-only while still exposing the');
    console.log('    proxy, set LLM_FW_DASHBOARD_BIND=127.0.0.1.');
  } else {
    console.log(`llm-fw running.`);
    console.log(`  Proxy port:  ${config.proxy.port}`);
    console.log(`  HTTPS_PROXY: http://127.0.0.1:${config.proxy.port}`);
    console.log(`  Dashboard:   http://127.0.0.1:${config.dashboard.port}`);
  }

  // Keep process alive
  setInterval(() => { }, 1 << 30);
}
