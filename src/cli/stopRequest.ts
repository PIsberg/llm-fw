import fs from 'node:fs';
import { join } from 'node:path';

/**
 * A stop request the running `llm-fw start` can see without a signal.
 *
 * On Windows `process.kill(pid, 'SIGTERM')` is TerminateProcess: start's
 * SIGTERM handler never runs, so the hosts file was never restored, the :443
 * portproxy rules were never removed and the audit sinks were never flushed
 * (#310). `stop` writes the target pid to `<LLM_FW_DIR>/llm-fw.stop`, and the
 * running process polls for it and takes the same graceful path as SIGTERM.
 */
export function stopRequestPath(dir: string): string {
  return join(dir, 'llm-fw.stop');
}

/** Ask the process `pid` to shut down gracefully. */
export function requestStop(dir: string, pid: number): void {
  fs.writeFileSync(stopRequestPath(dir), String(pid), 'utf8');
}

/** Remove a pending request, so a request nobody answered cannot stop a later instance. */
export function clearStopRequest(dir: string): void {
  try { fs.unlinkSync(stopRequestPath(dir)); } catch { /* none pending */ }
}

/**
 * Poll for a stop request naming `pid` and call `onStop` once when one
 * arrives. A request already present is cleared first: it was meant for an
 * earlier instance. The timer is unref'd so it never keeps the process alive.
 * Returns a function that stops watching.
 */
export function watchForStopRequest(dir: string, pid: number, onStop: () => void, intervalMs = 250): () => void {
  const file = stopRequestPath(dir);
  clearStopRequest(dir);
  const timer = setInterval(() => {
    let target: number;
    try {
      target = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    } catch {
      return;
    }
    if (target !== pid) return;
    clearInterval(timer);
    clearStopRequest(dir);
    onStop();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
