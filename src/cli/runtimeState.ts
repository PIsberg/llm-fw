import fs from 'node:fs';
import { join } from 'node:path';

/**
 * What the running `llm-fw start` process actually started, as opposed to what
 * config.json says. `--observe`, `--gateway` and `--standalone` are applied in
 * memory, and the sinkhole can be switched on by a hosts-file marker, so no
 * other process can recover them from config. `status`, `doctor` and the
 * dashboard's `/api/status` read this instead (#320, #338).
 *
 * Written next to the pid file once every listener is up, removed on a
 * graceful shutdown. A file left behind by a killed process is recognised by
 * its pid not matching the pid file.
 */
export interface RuntimeState {
  pid: number;
  startedAt: string;
  enforcement: 'enforce' | 'observe';
  proxyUrl: string;
  dashboardUrl: string;
  /** null when no gateway listener was started. */
  gatewayUrl: string | null;
  sinkhole: boolean;
}

export const RUNTIME_STATE_FILE = 'llm-fw.state.json';

export function writeRuntimeState(dir: string, state: RuntimeState): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, RUNTIME_STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
}

/** The recorded state, or null when there is none, it is unreadable, or it belongs to another pid. */
export function readRuntimeState(dir: string, pid: number): RuntimeState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(join(dir, RUNTIME_STATE_FILE), 'utf8')) as Partial<RuntimeState>;
    if (parsed.pid !== pid) return null;
    return parsed as RuntimeState;
  } catch {
    return null;
  }
}

export function removeRuntimeState(dir: string): void {
  try { fs.unlinkSync(join(dir, RUNTIME_STATE_FILE)); } catch { /* already gone */ }
}

/** The line `status` and `doctor` print for the enforcement mode. */
export function enforcementLine(state: RuntimeState | null): string {
  if (!state) return 'unknown (started by an llm-fw that did not record it; restart to see it)';
  return state.enforcement === 'observe' ? 'observe (nothing is blocked)' : 'enforce';
}
