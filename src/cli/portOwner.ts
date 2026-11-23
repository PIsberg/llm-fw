import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { systemTool } from '../systemTool.js';

/**
 * Freeing llm-fw's own ports before `start` binds them (#863).
 *
 * `start` used to kill whatever listened on the proxy or dashboard port,
 * which could be anything: a dev server on 8080, another tool on 7731. A
 * process's command line does not say reliably that it is llm-fw (`node
 * dist/cli/index.js start` names nothing), so the port is asked instead: the
 * proxy answers a plain HTTP request with a 501 that names llm-fw, and the
 * dashboard's page does too. Only an owner whose port answers that way is
 * stopped.
 */
export interface PortOwnerDeps {
  os: NodeJS.Platform;
  /** Runs a program without a shell and returns its stdout; throws on failure. */
  run: (file: string, args: string[]) => string;
  selfPid: number;
}

/** The processes listening on `port`, this one excluded. */
export function listeningPids(port: number, deps: PortOwnerDeps): number[] {
  const pids = new Set<number>();
  try {
    if (deps.os === 'win32') {
      const out = deps.run(systemTool('netstat', deps.os), ['-ano']);
      for (const line of out.split(/\r?\n/)) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
        if (m && Number(m[1]) === port) pids.add(Number(m[2]));
      }
    } else {
      // No shell, so the port can never be read as a command.
      for (const s of deps.run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).trim().split('\n')) {
        const pid = Number.parseInt(s, 10);
        if (pid) pids.add(pid);
      }
    }
  } catch { /* the tool is missing, or nothing listens */ }
  pids.delete(deps.selfPid);
  return [...pids].filter(pid => pid > 0);
}

/** Whether the server on 127.0.0.1:`port` answers a plain GET the way llm-fw's proxy or dashboard does. */
export function answersAsLlmFw(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    let body = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs, headers: { host: `127.0.0.1:${port}` } }, res => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 65_536) body += chunk;
      });
      res.on('end', () => resolve(body.includes('llm-fw')));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Stop the owners of `port` when it answers as llm-fw. Returns the owners
 * found and whether they were stopped; the caller refuses to start when an
 * owner was found and not stopped.
 */
export async function freeLlmFwPort(
  port: number,
  deps: PortOwnerDeps & { kill: (pid: number) => void; probe?: (port: number) => Promise<boolean> },
): Promise<{ owners: number[]; stopped: boolean }> {
  const owners = listeningPids(port, deps);
  if (owners.length === 0) return { owners, stopped: false };
  if (!await (deps.probe ?? answersAsLlmFw)(port)) return { owners, stopped: false };
  for (const pid of owners) {
    try { deps.kill(pid); } catch { /* gone already */ }
  }
  return { owners, stopped: true };
}

/** The real programs, for `start`. */
export const systemPortDeps: PortOwnerDeps & { kill: (pid: number) => void } = {
  os: process.platform,
  run: (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  selfPid: process.pid,
  kill: pid => process.kill(pid),
};

/**
 * Whether `port` can be bound on `host`, the address llm-fw will listen on,
 * retried until `timeoutMs`. Bound without a host, the check took the
 * wildcard address, which on Windows succeeds while another program holds
 * 127.0.0.1:<port> (#863).
 */
export async function waitForPortFree(port: number, host: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const free = await new Promise<boolean>(resolve => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, host, () => srv.close(() => resolve(true)));
    });
    if (free) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, 100));
  }
}
