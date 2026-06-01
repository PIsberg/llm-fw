import { loadConfig } from '../config/config.js';
import { ProxyServer } from '../proxy/proxy.js';
import { CertFactory } from '../proxy/certs.js';
import { createDashboardServer } from '../dashboard/server.js';
import { EventBus } from '../dashboard/eventBus.js';
import { Pipeline } from '../detection/pipeline.js';
import forge from 'node-forge';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

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
        if (m && parseInt(m[1]!, 10) === port) {
          const pid = parseInt(m[2]!, 10);
          if (pid && pid !== process.pid) try { process.kill(pid) } catch { }
        }
      }
    } else {
      const out = execSync(`lsof -ti :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const pidStr of out.trim().split('\n')) {
        const pid = parseInt(pidStr, 10);
        if (pid && pid !== process.pid) try { process.kill(pid) } catch { }
      }
    }
  } catch { /* command unavailable */ }
}

export async function run(): Promise<void> {
  const config = await loadConfig();
  const llmfwDir = join(homedir(), '.llm-fw');
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
  const sinkholeActive = config.proxy.mode === 'sinkhole' || hostsHasSinkhole;

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
        const existing = execSync('netsh interface portproxy show v4tov4', { encoding: 'utf8' });
        if (!existing.includes('443')) {
          execFileSync('netsh', [
            'interface', 'portproxy', 'add', 'v4tov4',
            'listenport=443', 'listenaddress=127.0.0.1',
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

  // Register cleanup hooks before any IO
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanup();
    process.exit(1);
  });

  // Write PID file
  fs.mkdirSync(llmfwDir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');

  const eventBus = new EventBus(config.dashboard);
  const pipeline = new Pipeline(config, (partial) => eventBus.emit(partial));

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

  const dashboardServer = createDashboardServer(config, eventBus, pipeline);
  dashboardServer.listen(config.dashboard.port, () => {
    // listening
  });

  const proxy = new ProxyServer(config, eventBus);
  await proxy.init();
  proxy.start();

  if (sinkholeActive) {
    proxy.startSinkhole(config.proxy.httpsPort);
    console.log(`  Sinkhole TLS: 127.0.0.1:${config.proxy.httpsPort} (via portproxy → :443)`);
  }

  console.log(`llm-fw running.`);
  console.log(`  Proxy port:  ${config.proxy.port}`);
  console.log(`  HTTPS_PROXY: http://127.0.0.1:${config.proxy.port}`);
  console.log(`  Dashboard:   http://127.0.0.1:${config.dashboard.port}`);

  // Keep process alive
  setInterval(() => { }, 1 << 30);
}
