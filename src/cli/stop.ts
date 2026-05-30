import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function run(): Promise<void> {
  const pidFile = join(homedir(), '.llm-fw', 'llm-fw.pid');

  if (!fs.existsSync(pidFile)) {
    console.log('llm-fw is not running.');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (isNaN(pid)) {
    console.log('llm-fw is not running (invalid PID file).');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.log('llm-fw is not running (process not found).');
    try { fs.unlinkSync(pidFile); } catch {}
    return;
  }

  // Poll every 200ms for up to 5s
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));

    const pidFileGone = !fs.existsSync(pidFile);
    let processDead = false;
    try {
      process.kill(pid, 0);
    } catch {
      processDead = true;
    }

    if (pidFileGone || processDead) {
      console.log('llm-fw stopped.');
      return;
    }
  }

  // Timed out — force kill
  console.warn('Process did not stop in time. Sending SIGKILL...');
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
  console.log('llm-fw killed.');
}
