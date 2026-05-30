import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config/config.js';

export async function run(): Promise<void> {
  const pidFile = join(homedir(), '.llm-fw', 'llm-fw.pid');

  if (!fs.existsSync(pidFile)) {
    console.log('llm-fw: stopped');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (isNaN(pid)) {
    console.log('llm-fw: stopped (invalid PID file)');
    return;
  }

  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {}

  if (!alive) {
    console.log(`llm-fw: stopped (stale PID ${pid} in pid file)`);
    return;
  }

  const config = await loadConfig();
  console.log(`llm-fw: running`);
  console.log(`  PID:       ${pid}`);
  console.log(`  Mode:      ${config.proxy.mode}`);
  console.log(`  Proxy:     http://127.0.0.1:${config.proxy.port}`);
  console.log(`  Dashboard: http://127.0.0.1:${config.dashboard.port}`);
}
