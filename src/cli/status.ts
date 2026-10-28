import fs from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { loadConfig } from '../config/config.js';
import { getLlmFwDir } from '../config/paths.js';
import { enforcementLine, readRuntimeState } from './runtimeState.js';

export async function run(): Promise<void> {
  await reportStatus();

  // Printed on every path, including the stopped ones. A licence notice you can
  // dodge by not starting the firewall is a licence notice nobody sees.
  const { statusLine, unlicensedBanner } = await import('./license.js');
  console.log(`  Licence:     ${statusLine()}`);
  for (const line of unlicensedBanner()) console.log(line);
}

async function reportStatus(): Promise<void> {
  const pidFile = join(getLlmFwDir(), 'llm-fw.pid');

  if (!fs.existsSync(pidFile)) {
    console.log('llm-fw: stopped');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (Number.isNaN(pid)) {
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

  // What the running process recorded at startup. `--observe` and `--gateway`
  // exist only in its memory, so config.json alone cannot answer (#320).
  const state = readRuntimeState(getLlmFwDir(), pid);
  const config = await loadConfig();

  // The proxy always runs; the sinkhole runs additionally when active. Without
  // a recorded state, detect it from config OR the hosts file (covers an
  // elevated setup whose config.json wasn't written), mirroring `start`.
  const hostsPath = platform() === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';
  const hostsHasSinkhole = (() => {
    try { return fs.readFileSync(hostsPath, 'utf8').includes('# llm-fw sinkhole'); }
    catch { return false; }
  })();
  const sinkholeActive = state ? state.sinkhole : config.proxy.mode === 'sinkhole' || hostsHasSinkhole;

  console.log(`llm-fw: running`);
  console.log(`  PID:         ${pid}`);
  console.log(`  Enforcement: ${enforcementLine(state)}`);
  const proxyUrl = state?.proxyUrl ?? `http://127.0.0.1:${config.proxy.port}`;
  console.log(`  Proxy:       ${proxyUrl}  — HTTPS_PROXY tools (curl, Python, …)`);
  console.log(`  Sinkhole:    ${sinkholeActive ? 'active — Node.js & native tools (Claude Code, SDKs, …)' : 'off — run "llm-fw setup" elevated to enable'}`);
  if (state) console.log(`  Gateway:     ${state.gatewayUrl ?? 'off'}`);
  const dashUrl = state?.dashboardUrl ?? `http://127.0.0.1:${config.dashboard.port}`;
  console.log(`  Dashboard:   ${dashUrl}`);
}
