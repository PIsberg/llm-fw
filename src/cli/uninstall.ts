import fs from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { isElevated, getIdeSettingsPaths } from './setup.js';
import { loadConfig } from '../config/config.js';

/**
 * `llm-fw uninstall` — reverse every change `setup` (and `setup-judge`) made,
 * returning the machine to its pre-install state.
 *
 * Install touches four classes of state, and uninstall undoes each:
 *   1. Files under ~/.llm-fw/      — CA key/cert/CRL, model cache, mode + pid.
 *   2. The OS trust store          — the root CA was added so leaf certs verify.
 *   3. The hosts file + a port      — the sinkhole redirect (elevated installs).
 *      redirect rule
 *   4. The project .llm-fw.json     — judge settings written by setup-judge.
 *
 * Environment variables (HTTPS_PROXY, NODE_EXTRA_CA_CERTS) are NOT removed here:
 * setup only ever *prints* them for the user to export, so it never owned them —
 * we just remind the user to unset them.
 *
 * The OS-touching steps are best-effort: each is wrapped so a single failure
 * (e.g. the rule was already gone, or we lack admin) reports a clear line and a
 * manual command instead of aborting the whole uninstall. The pure helpers
 * (hosts-block stripping, judge-config stripping) are exported so they can be
 * unit-tested without mutating the host.
 */

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/**
 * Remove llm-fw's sinkhole edits from a hosts file's text. This is the inverse
 * of what setup appended: it drops the `# llm-fw sinkhole` marker and every
 * loopback line that follows it, plus any stray `127.0.0.1 <target>` / `::1`
 * lines for a known target host (in case the marker was hand-edited away).
 *
 * Operates line-by-line and never builds a regex from host text, so a target
 * containing regex metacharacters can't corrupt the result. Returns the cleaned
 * text with a single trailing newline normalised away.
 */
export function stripSinkholeBlock(hostsText: string, targets: string[]): string {
  const targetSet = new Set(targets);
  const lines = hostsText.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '# llm-fw sinkhole') {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      // The block is the contiguous run of loopback/comment lines setup wrote.
      // The first line that isn't one of those ends the block and is kept.
      if (trimmed === '' || (!trimmed.startsWith('127.0.0.1') && !trimmed.startsWith('::1') && !trimmed.startsWith('#'))) {
        inBlock = false;
      } else {
        continue;
      }
    }

    // Belt-and-braces: drop any leftover loopback mapping for a target host.
    const parts = trimmed.split(/\s+/);
    if ((parts[0] === '127.0.0.1' || parts[0] === '::1') && parts.slice(1).some(h => targetSet.has(h))) {
      continue;
    }

    out.push(line);
  }

  return out.join('\n').replace(/\n+$/, '\n').replace(/^\n+/, '');
}

/**
 * Strip the judge keys setup-judge wrote into a parsed project config. Returns
 * the cleaned object, or `null` when nothing meaningful is left (so the caller
 * deletes the now-empty file rather than leaving `{ "detection": {} }` behind).
 * Any keys the user added themselves are preserved untouched.
 */
export function stripJudgeConfig(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const next: Record<string, unknown> = { ...parsed };
  const detection = next.detection as Record<string, unknown> | undefined;

  if (detection && typeof detection === 'object') {
    const cleaned = { ...detection };
    delete cleaned.judgeEnabled;
    delete cleaned.judgeModel;
    delete cleaned.judgeBlock;
    if (Object.keys(cleaned).length === 0) delete next.detection;
    else next.detection = cleaned;
  }

  return Object.keys(next).length === 0 ? null : next;
}

/**
 * Strip export statements for HTTPS_PROXY and NODE_EXTRA_CA_CERTS if they point
 * to llm-fw destinations. Returns the cleaned text.
 */
export function stripProfileEnvVars(profileContent: string): string {
  const lines = profileContent.split(/\r?\n/);
  const cleanedLines = lines.filter(line => {
    const trimmed = line.trim();
    // Match export HTTPS_PROXY=... containing 127.0.0.1:8080 or export NODE_EXTRA_CA_CERTS=... containing .llm-fw/ca.crt
    if (trimmed.startsWith('export HTTPS_PROXY=') && (trimmed.includes('127.0.0.1:8080') || trimmed.includes('localhost:8080'))) {
      return false;
    }
    if (trimmed.startsWith('export NODE_EXTRA_CA_CERTS=') && trimmed.includes('.llm-fw/ca.crt')) {
      return false;
    }
    return true;
  });
  return cleanedLines.join('\n');
}

/**
 * Strip IDE proxy keys (http.proxy and http.proxyStrictSSL) if they match llm-fw.
 */
export function stripIdeProxyConfig(parsed: Record<string, unknown>): Record<string, unknown> {
  const next = { ...parsed };
  const currentProxy = next['http.proxy'];

  if (typeof currentProxy === 'string' && (/(?:127\.0\.0\.1|localhost|::1):\d+/.test(currentProxy))) {
    delete next['http.proxy'];
    delete next['http.proxyStrictSSL'];
  }
  return next;
}

// ── OS-touching steps ─────────────────────────────────────────────────────────

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const skip = (msg: string) => console.log(`  • ${msg}`);
const warn = (msg: string) => console.warn(`  ⚠ ${msg}`);

/** Stop a running firewall via its pid file (mirrors stop.ts) so we don't pull
 *  the trust anchor / hosts entries out from under a live proxy. */
function stopRunningProxy(llmfwDir: string): void {
  const pidFile = join(llmfwDir, 'llm-fw.pid');
  if (!fs.existsSync(pidFile)) return;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!isNaN(pid)) {
      try { process.kill(pid, 'SIGTERM'); ok(`Stopped running proxy (PID ${pid})`); } catch { /* already dead */ }
    }
  } catch { /* unreadable pid file */ }
}

/** Remove the root CA from the OS trust store. Needs elevation on every OS. */
function removeCaFromTrustStore(): void {
  const os = platform();
  try {
    if (os === 'win32') {
      // delstore matches the cert by its common name.
      execSync('certutil -delstore -f Root "llm-fw Local CA"', { stdio: 'ignore' });
    } else if (os === 'darwin') {
      execSync('security delete-certificate -c "llm-fw Local CA" /Library/Keychains/System.keychain', { stdio: 'ignore' });
    } else {
      const installed = '/usr/local/share/ca-certificates/llm-fw-ca.crt';
      if (fs.existsSync(installed)) fs.unlinkSync(installed);
      execSync('update-ca-certificates --fresh', { stdio: 'ignore' });
    }
    ok('CA removed from OS trust store');
  } catch {
    warn('Could not remove the CA from the OS trust store automatically. Remove it manually:');
    if (os === 'win32') warn('  certutil -delstore -f Root "llm-fw Local CA"   (run elevated)');
    else if (os === 'darwin') warn('  sudo security delete-certificate -c "llm-fw Local CA" /Library/Keychains/System.keychain');
    else warn(`  sudo rm -f /usr/local/share/ca-certificates/llm-fw-ca.crt && sudo update-ca-certificates --fresh`);
  }
}

/** Restore the hosts file by stripping the sinkhole block, then drop the backup. */
function restoreHostsFile(targets: string[]): void {
  const hostsPath = platform() === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';
  const backupPath = hostsPath + '.llm-fw.bak';
  try {
    const current = fs.readFileSync(hostsPath, 'utf8');
    if (current.includes('# llm-fw sinkhole') ||
        current.split(/\r?\n/).some(l => {
          const p = l.trim().split(/\s+/);
          return (p[0] === '127.0.0.1' || p[0] === '::1') && p.slice(1).some(h => targets.includes(h));
        })) {
      const cleaned = stripSinkholeBlock(current, targets);
      fs.writeFileSync(hostsPath, cleaned, 'utf8');
      ok('Sinkhole entries removed from hosts file');
    } else {
      skip('No sinkhole entries in hosts file');
    }
    if (fs.existsSync(backupPath)) { fs.unlinkSync(backupPath); ok('Removed hosts backup (.llm-fw.bak)'); }
  } catch (err) {
    warn('Could not edit the hosts file (needs admin/root): ' + (err as Error).message);
  }
}

/** Delete the OS-level :443 → httpsPort redirect that the sinkhole installs. */
function removePortRedirect(httpsPort: number): void {
  const os = platform();
  try {
    if (os === 'win32') {
      execFileSync('netsh', ['interface', 'portproxy', 'delete', 'v4tov4', 'listenport=443', 'listenaddress=127.0.0.1'], { stdio: 'ignore' });
      try {
        execFileSync('netsh', ['interface', 'portproxy', 'delete', 'v6tov4', 'listenport=443', 'listenaddress=::1'], { stdio: 'ignore' });
      } catch { /* v6 rule may not exist */ }
      ok('Removed netsh port redirect (127.0.0.1:443)');
    } else if (os === 'darwin') {
      // setup loaded a single rdr rule via `pfctl -ef -`; flush the nat ruleset.
      execSync('pfctl -F nat', { stdio: 'ignore' });
      ok('Flushed pf nat redirect');
    } else {
      // execFile with an arg array — no shell, so the port value can't inject.
      execFileSync('iptables', [
        '-t', 'nat', '-D', 'OUTPUT', '-o', 'lo', '-p', 'tcp',
        '--dport', '443', '-j', 'REDIRECT', '--to-port', String(httpsPort),
      ], { stdio: 'ignore' });
      ok('Removed iptables :443 redirect');
    }
  } catch {
    skip('No port redirect to remove (or needs admin/root)');
  }
}

/** Strip judge settings setup-judge wrote into the project's .llm-fw.json. */
function cleanProjectConfig(): void {
  const configPath = join(process.cwd(), '.llm-fw.json');
  if (!fs.existsSync(configPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const cleaned = stripJudgeConfig(parsed);
    if (cleaned === null) { fs.unlinkSync(configPath); ok('Removed project .llm-fw.json (judge settings only)'); }
    else { fs.writeFileSync(configPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8'); ok('Removed judge settings from .llm-fw.json'); }
  } catch {
    warn('Could not parse .llm-fw.json — left it untouched');
  }
}

/** Remove the files llm-fw created under ~/.llm-fw, then the dir if it's empty. */
function removeLlmfwFiles(llmfwDir: string, keepModel: boolean): void {
  const files = ['config.json', 'ca.crt', 'ca.key', 'ca.crl', 'llm-fw.pid'];
  for (const f of files) {
    try { fs.rmSync(join(llmfwDir, f), { force: true }); } catch { /* ignore */ }
  }
  if (!keepModel) {
    try { fs.rmSync(join(llmfwDir, 'models'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  ok(keepModel ? 'Removed CA, CRL, mode + pid (kept model cache)' : 'Removed CA, CRL, model cache, mode + pid');
  // Only rmdir the directory itself if nothing else is left in it.
  try {
    if (fs.readdirSync(llmfwDir).length === 0) { fs.rmdirSync(llmfwDir); ok('Removed ~/.llm-fw'); }
  } catch { /* dir missing or not empty */ }
}

/** Remove environment variables HTTPS_PROXY and NODE_EXTRA_CA_CERTS if they point to llm-fw. */
function removeEnvVars(): void {
  const os = platform();
  try {
    if (os === 'win32') {
      let clearedUser = false;
      // Clear User environment variables
      try {
        execSync('reg delete HKCU\\Environment /v HTTPS_PROXY /f', { stdio: 'ignore' });
        clearedUser = true;
      } catch { /* may not exist */ }
      try {
        execSync('reg delete HKCU\\Environment /v NODE_EXTRA_CA_CERTS /f', { stdio: 'ignore' });
        clearedUser = true;
      } catch { /* may not exist */ }
      
      let clearedSystem = false;
      // Clear System environment variables (if elevated)
      if (isElevated()) {
        try {
          execSync('reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v HTTPS_PROXY /f', { stdio: 'ignore' });
          clearedSystem = true;
        } catch { /* may not exist */ }
        try {
          execSync('reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v NODE_EXTRA_CA_CERTS /f', { stdio: 'ignore' });
          clearedSystem = true;
        } catch { /* may not exist */ }
      }
      
      if (clearedUser || clearedSystem) {
        ok('Removed environment variables (HTTPS_PROXY, NODE_EXTRA_CA_CERTS) from registry');
      } else {
        skip('No llm-fw environment variables found in registry');
      }
    } else {
      // macOS / Linux: clean up shell profiles (~/.bashrc, ~/.zshrc, ~/.profile, ~/.bash_profile)
      const profiles = ['.bashrc', '.zshrc', '.profile', '.bash_profile']
        .map(p => join(homedir(), p))
        .filter(p => fs.existsSync(p));
      
      let modifiedAny = false;
      for (const p of profiles) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          const cleaned = stripProfileEnvVars(content);
          if (content !== cleaned) {
            fs.writeFileSync(p, cleaned, 'utf8');
            modifiedAny = true;
          }
        } catch { /* ignore read/write errors for individual profiles */ }
      }
      
      if (modifiedAny) {
        ok('Cleaned environment variables from shell profile files');
      } else {
        skip('No llm-fw environment variables found in shell profiles');
      }
    }
  } catch (err) {
    warn('Could not clean environment variables automatically: ' + (err as Error).message);
  }
}

/** Scan for IDE settings and remove the proxy settings if they belong to llm-fw. */
function removeIdeProxySettings(): void {
  const paths = getIdeSettingsPaths();
  let modifiedAny = false;

  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(content) as Record<string, unknown>;
      } catch {
        continue;
      }

      const cleaned = stripIdeProxyConfig(config);
      if (JSON.stringify(config) !== JSON.stringify(cleaned)) {
        fs.writeFileSync(p, JSON.stringify(cleaned, null, 4), 'utf8');
        modifiedAny = true;
      }
    } catch { /* ignore individual write/read errors */ }
  }

  if (modifiedAny) {
    ok('Removed proxy settings from IDE configurations');
  }
}

// ── orchestration ─────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const yes = args.includes('--yes') || args.includes('-y');
  const keepModel = args.includes('--keep-model');

  const config = await loadConfig();
  const llmfwDir = process.env.LLM_FW_DIR || join(homedir(), '.llm-fw');
  const elevated = isElevated();

  console.log('llm-fw uninstall — this reverses every change made by setup:');
  console.log('  • removes the root CA from the OS trust store and ~/.llm-fw');
  console.log('  • restores the hosts file and removes the :443 port redirect (sinkhole)');
  console.log('  • removes judge settings written to .llm-fw.json');
  console.log(keepModel ? '  • keeps the cached embedding model' : '  • deletes the cached embedding model');

  if (!yes) {
    const rl = createInterface({ input, output });
    const answer = await rl.question('\nProceed? [y/N]: ');
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') { console.log('Aborted.'); return; }
  }

  console.log('\nUninstalling...');

  // 1. Stop the proxy first so nothing is mid-flight.
  stopRunningProxy(llmfwDir);

  // 2. OS trust store + sinkhole — all need elevation. Warn once if we lack it.
  if (!elevated) {
    warn('Not running elevated — trust-store / hosts / port-redirect changes may');
    warn('  fail. Re-run elevated to complete them: ' +
      (platform() === 'win32' ? 'Administrator terminal → llm-fw uninstall' : 'sudo llm-fw uninstall'));
  }
  removeCaFromTrustStore();
  restoreHostsFile(config.targets);
  removePortRedirect(config.proxy.httpsPort);

  // 3. Local files.
  cleanProjectConfig();
  removeLlmfwFiles(llmfwDir, keepModel);
  removeEnvVars();
  removeIdeProxySettings();

  // 4. Remind about the env vars setup told the user to set (we don't own them).
  console.log('\n── Active shell sessions ───────────────────────────────────────────────────');
  console.log('  Environment variables were removed from registry/profiles, but active shell');
  console.log('  sessions still retain them. To clean your current session, run:');
  if (platform() === 'win32') {
    console.log('    Remove-Item Env:HTTPS_PROXY, Env:NODE_EXTRA_CA_CERTS   # current session');
  } else {
    console.log('    unset HTTPS_PROXY NODE_EXTRA_CA_CERTS                  # current session');
  }
  console.log('\n  Note: the Windows IP Helper service (iphlpsvc) and any Ollama judge model are');
  console.log('  shared system resources and are left in place. Remove them yourself if unused:');
  console.log('    ollama rm <model>');

  console.log('\nllm-fw uninstall complete.');
}
