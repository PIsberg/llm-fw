import { loadConfig } from '../config/config.js';
import { ProxyServer } from '../proxy/proxy.js';
import { createDashboardServer } from '../dashboard/server.js';
import { EventBus } from '../dashboard/eventBus.js';
import { Pipeline } from '../detection/pipeline.js';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

export async function run(): Promise<void> {
  const config = await loadConfig();
  const llmfwDir = join(homedir(), '.llm-fw');
  const pidFile = join(llmfwDir, 'llm-fw.pid');
  const sinkholeActive = config.proxy.mode === 'sinkhole';

  const hostsPath = platform() === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';

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
    }
    try {
      fs.unlinkSync(pidFile);
    } catch {}
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

  console.log(`llm-fw running.`);
  console.log(`  Proxy port:  ${config.proxy.port}`);
  console.log(`  HTTPS_PROXY: http://127.0.0.1:${config.proxy.port}`);
  console.log(`  Dashboard:   http://127.0.0.1:${config.dashboard.port}`);

  // Keep process alive
  setInterval(() => {}, 1 << 30);
}
