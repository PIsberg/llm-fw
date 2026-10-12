import fs from 'node:fs';
import { join } from 'node:path';
import { getLlmFwDir } from '../config/paths.js';
import { clearStopRequest, requestStop } from './stopRequest.js';

export interface StopOptions {
  /** How long to wait for the process to answer the stop request before signalling it. */
  requestWaitMs?: number;
}

export async function run(options: StopOptions = {}): Promise<void> {
  const dir = getLlmFwDir();
  const pidFile = join(dir, 'llm-fw.pid');

  if (!fs.existsSync(pidFile)) {
    console.log('llm-fw is not running.');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (isNaN(pid)) {
    console.log('llm-fw is not running (invalid PID file).');
    return;
  }

  if (!isAlive(pid)) {
    console.log('llm-fw is not running (process not found).');
    removePidFile(pidFile, pid);
    return;
  }

  // Ask first. On Windows a signal is TerminateProcess, so start's graceful
  // shutdown (hosts file restore, :443 portproxy removal, audit flush) only
  // runs if the process stops itself (#310).
  requestStop(dir, pid);
  if (await waitForExit(pid, pidFile, options.requestWaitMs ?? 5000)) {
    clearStopRequest(dir);
    removePidFile(pidFile, pid);
    console.log('llm-fw stopped.');
    return;
  }
  // Unanswered: an older start without the watcher, or a hung process.
  clearStopRequest(dir);

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removePidFile(pidFile, pid);
    console.log('llm-fw stopped.');
    return;
  }

  if (await waitForExit(pid, pidFile, 5000)) {
    // On Windows SIGTERM is TerminateProcess, so start's exit handler never
    // runs and the pid file outlives the process. Clean up after it here.
    removePidFile(pidFile, pid);
    console.log('llm-fw stopped.');
    return;
  }

  // Timed out — force kill
  console.warn('Process did not stop in time. Sending SIGKILL...');
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
  removePidFile(pidFile, pid);
  console.log('llm-fw killed.');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll every 200ms until the process is gone or has removed its pid file. */
async function waitForExit(pid: number, pidFile: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (!fs.existsSync(pidFile) || !isAlive(pid)) return true;
  }
  return false;
}

/** Remove the pid file only if it still names the process we stopped. */
function removePidFile(pidFile: string, pid: number): void {
  try {
    if (parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) === pid) fs.unlinkSync(pidFile);
  } catch { /* already gone */ }
}
