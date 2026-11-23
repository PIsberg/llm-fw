import { execFileSync } from 'node:child_process';

/**
 * The :443 redirect sinkhole mode needs on macOS and Linux (#863). Windows
 * uses `netsh interface portproxy`, which setup and start run inline.
 *
 * macOS: the rule lives in its own pf anchor. It was loaded with `pfctl
 * -ef -`, which replaces the main ruleset, and removed with `pfctl -F nat`,
 * which flushes every NAT rule on the host, Docker Desktop's, a VPN's and a
 * VM's included. The anchor sits under `com.apple/`, which the stock
 * /etc/pf.conf already evaluates (`rdr-anchor "com.apple/*"`), so no change
 * to pf.conf is needed and flushing the anchor touches nothing else.
 *
 * Linux: iptables is asked (`-C`) before the rule is added, since every start
 * appended another copy, and removal deletes every copy.
 */
export const PF_ANCHOR = 'com.apple/llm-fw';

/** Runs a program without a shell, optionally with stdin; throws on a non-zero exit. */
export type Run = (file: string, args: string[], input?: string) => string;

export const systemRun: Run = (file, args, input) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) });

function pfRule(httpsPort: number): string {
  return `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${httpsPort}\n`;
}

function iptablesRule(op: '-C' | '-A' | '-D', httpsPort: number): string[] {
  return ['-t', 'nat', op, 'OUTPUT', '-o', 'lo', '-p', 'tcp', '--dport', '443', '-j', 'REDIRECT', '--to-port', String(httpsPort)];
}

/** Add the redirect. Throws when the platform refuses (no privileges). */
export function addPortRedirect(os: NodeJS.Platform, httpsPort: number, run: Run = systemRun): void {
  if (os === 'darwin') {
    run('pfctl', ['-a', PF_ANCHOR, '-f', '-'], pfRule(httpsPort));
    // Enable pf; -E takes a reference rather than toggling, and an
    // already-enabled pf is not an error worth failing on.
    try { run('pfctl', ['-E']); } catch { /* already enabled */ }
    return;
  }
  try {
    run('iptables', iptablesRule('-C', httpsPort));
  } catch {
    run('iptables', iptablesRule('-A', httpsPort));
  }
}

/** Remove the redirect, every copy of it. Never throws. */
export function removePortRedirect(os: NodeJS.Platform, httpsPort: number, run: Run = systemRun): void {
  if (os === 'darwin') {
    try { run('pfctl', ['-a', PF_ANCHOR, '-F', 'nat']); } catch { /* not loaded */ }
    return;
  }
  for (let i = 0; i < 32; i++) {
    try {
      run('iptables', iptablesRule('-C', httpsPort));
    } catch {
      return;
    }
    try { run('iptables', iptablesRule('-D', httpsPort)); } catch { return; }
  }
}
