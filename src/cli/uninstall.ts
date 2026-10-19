import fs from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { isElevated, getIdeSettingsPaths } from './setup.js';
import { serializeLike } from './jsonFormat.js';
import { loadConfig } from '../config/config.js';
import { getLlmFwDir } from '../config/paths.js';
import { run as stopFirewall } from './stop.js';

/**
 * `llm-fw uninstall` — reverse every change `setup` (and `setup-judge`) made,
 * returning the machine to its pre-install state.
 *
 * Install touches six classes of state, and uninstall undoes each:
 *   1. Files under ~/.llm-fw/      — CA key/cert/CRL, model cache, whitelist,
 *                                     mode + pid.
 *   2. The OS trust store          — the root CA was added so leaf certs verify.
 *   3. The hosts file + a port      — the sinkhole redirect (elevated installs).
 *      redirect rule
 *   4. The project .llm-fw.json     — judge settings written by setup-judge.
 *   5. IDE proxy settings           — http.proxy / http.proxyStrictSSL written
 *                                     to VS Code / Antigravity settings.json.
 *   6. Env vars                     — HTTPS_PROXY / NODE_EXTRA_CA_CERTS removed
 *                                     from the registry (Windows) or shell
 *                                     profiles (macOS/Linux); active shell
 *                                     sessions still need a manual unset.
 *
 * The OS-touching steps are best-effort: each is wrapped so a single failure
 * (e.g. the rule was already gone, or we lack admin) reports a clear line and a
 * manual command instead of aborting the whole uninstall. The pure helpers
 * (hosts-block stripping, judge-config stripping) are exported so they can be
 * unit-tested without mutating the host.
 */

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

// Shared with setup (which strips before re-appending); re-exported so existing
// importers/tests keep working.
import { stripSinkholeBlock } from './hosts.js';
export { stripSinkholeBlock };

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
 * Strip the env-var exports `setup` (`addProfileEnvVars`) wrote into a shell
 * profile: the `# llm-fw env` marker, an HTTPS_PROXY export pointing at a
 * loopback proxy (any port), the NO_PROXY exclusion list setup wrote, and a
 * NODE_EXTRA_CA_CERTS export pointing at `~/.llm-fw/ca.crt`. A user's own
 * corporate-proxy, exclusion list, or unrelated CA export is left untouched.
 * Returns the cleaned text.
 */
export function stripProfileEnvVars(profileContent: string): string {
  const lines = profileContent.split(/\r?\n/);
  const cleanedLines = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed === '# llm-fw env') return false;
    if (trimmed.startsWith('export HTTPS_PROXY=') && (trimmed.includes('127.0.0.1:') || trimmed.includes('localhost:'))) {
      return false;
    }
    // Ours contains loopback; a user's own list (".mycompany.com") does not.
    if (trimmed.startsWith('export NO_PROXY=') && trimmed.includes('127.0.0.1')) {
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

/**
 * settings.json text with llm-fw's proxy keys removed, in the file's own
 * formatting, or null when there is nothing of ours to remove (or the file has
 * comments and cannot be rewritten without losing them).
 */
export function removeIdeProxy(content: string): string | null {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const cleaned = stripIdeProxyConfig(config);
  if (JSON.stringify(config) === JSON.stringify(cleaned)) return null;
  return serializeLike(content, cleaned);
}

// ── OS-touching steps ─────────────────────────────────────────────────────────

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const skip = (msg: string) => console.log(`  • ${msg}`);
const warn = (msg: string) => console.warn(`  ⚠ ${msg}`);

/** Stop a running firewall so we don't pull the trust anchor / hosts entries
 *  out from under a live proxy. Delegates to `llm-fw stop`: a SIGTERM of its
 *  own was TerminateProcess on Windows and skipped the graceful shutdown. */
export async function stopRunningProxy(llmfwDir: string): Promise<void> {
  if (!fs.existsSync(join(llmfwDir, 'llm-fw.pid'))) return;
  await stopFirewall({ dir: llmfwDir, log: ok });
}

/** Remove the root CA from the OS trust store. Needs elevation on every OS. */
export function removeCaFromTrustStore(os: NodeJS.Platform = platform()): void {
  // Look first: a non-elevated setup never installed the CA, and reporting a
  // failed delete of something absent sends the user off to re-run elevated
  // for nothing. Reading the store needs no elevation on any OS.
  if (!caInTrustStore(os)) {
    skip('CA not in the OS trust store — nothing to remove');
    return;
  }
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

/** Whether the llm-fw CA is installed. Errs towards true, so a failed probe still attempts the delete. */
function caInTrustStore(os: NodeJS.Platform): boolean {
  if (os !== 'win32' && os !== 'darwin') return fs.existsSync('/usr/local/share/ca-certificates/llm-fw-ca.crt');
  try {
    execSync(os === 'win32'
      ? 'certutil -store Root "llm-fw Local CA"'
      : 'security find-certificate -c "llm-fw Local CA" /Library/Keychains/System.keychain', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
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

/** Strip judge settings older setup-judge versions wrote into the project's
 *  .llm-fw.json (current versions persist to ~/.llm-fw/config.json, which is
 *  removed wholesale by removeLlmfwFiles). */
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

// What uninstall deletes from ~/.llm-fw (#322), with what each file means to
// the user. The policy: what makes this machine intercept traffic always
// goes; what the user authored stays unless --purge; the licence key always
// stays, since losing it costs a purchase.
const REMOVED_FILES: ReadonlyArray<readonly [string, string]> = [
  ['ca.crt', ''], ['ca.key', ''], ['ca.crl', ''], ['llm-fw.pid', ''], ['llm-fw.state.json', ''], ['llm-fw.stop', ''],
];
const PURGED_FILES: ReadonlyArray<readonly [string, string]> = [
  ['config.json', 'your settings'],
  ['whitelist.json', 'events recorded as false positives (audit only)'],
  ['suppressions.json', 'false positives that unblock future matches'],
  ['audit.jsonl', 'audit log'], ['audit.jsonl.1', 'rotated audit log'],
  ['ocr-cache', 'OCR cache'],
  ['tool-usage.json', 'which offered tools your clients called (Tool Usage module)'],
];

/**
 * Remove the `proxy.mode` setup wrote from config.json, keeping every other
 * setting; delete the file when that was all it held. Left in place, the mode
 * survives an uninstall and the next `start` acts on it, re-adding the
 * sinkhole's hosts entries. Returns true when the file changed.
 */
export function stripSetupMode(configPath: string): boolean {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>; } catch { return false; }
  const proxy = parsed.proxy as Record<string, unknown> | undefined;
  if (!proxy || typeof proxy !== 'object' || !('mode' in proxy)) return false;
  delete proxy.mode;
  if (Object.keys(proxy).length === 0) delete parsed.proxy;
  if (Object.keys(parsed).length === 0) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
  return true;
}

/**
 * Remove the files llm-fw created under ~/.llm-fw, then the dir if it's empty.
 * Reports each file it removed and each one it left, so a surviving ~/.llm-fw
 * (licence key, settings, audit log, suppressions) is explained rather than
 * discovered.
 */
export function removeLlmfwFiles(llmfwDir: string, opts: { keepModel: boolean; purge: boolean }): void {
  const removed: string[] = [];
  for (const [f, meaning] of opts.purge ? [...REMOVED_FILES, ...PURGED_FILES] : REMOVED_FILES) {
    const p = join(llmfwDir, f);
    if (!fs.existsSync(p)) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); removed.push(meaning ? `${f} (${meaning})` : f); } catch { /* ignore */ }
  }
  if (!opts.purge && stripSetupMode(join(llmfwDir, 'config.json'))) {
    removed.push('proxy.mode from config.json (the mode setup chose; your other settings are kept)');
  }
  const keepModel = opts.keepModel;
  if (!keepModel && fs.existsSync(join(llmfwDir, 'models'))) {
    try { fs.rmSync(join(llmfwDir, 'models'), { recursive: true, force: true }); removed.push('models/ (model cache)'); } catch { /* ignore */ }
  }
  if (removed.length > 0) ok(`Removed from ${llmfwDir}: ${removed.join(', ')}`);
  // Only rmdir the directory itself if nothing else is left in it.
  let left: string[];
  try { left = fs.readdirSync(llmfwDir); } catch { return; }
  if (left.length === 0) {
    try { fs.rmdirSync(llmfwDir); ok(`Removed ${llmfwDir}`); } catch { /* ignore */ }
    return;
  }
  const isDir = (n: string): boolean => { try { return fs.statSync(join(llmfwDir, n)).isDirectory(); } catch { return false; } };
  ok(`Left in ${llmfwDir}: ${left.map(n => (isDir(n) ? n + '/' : n)).join(', ')}`);
}

/** Remove environment variables HTTPS_PROXY and NODE_EXTRA_CA_CERTS if they point to llm-fw. */
function removeEnvVars(): void {
  const os = platform();
  try {
    if (os === 'win32') {
      let clearedUser = false;
      // Clear User environment variables. NO_PROXY is removed alongside the
      // proxy variable it accompanies: setup writes the pair, so uninstall
      // takes the pair, or the machine is left excluding hosts from a proxy
      // that no longer exists.
      const userVars = ['HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'];
      for (const name of userVars) {
        try {
          execSync(`reg delete HKCU\\Environment /v ${name} /f`, { stdio: 'ignore' });
          clearedUser = true;
        } catch { /* may not exist */ }
      }

      let clearedSystem = false;
      // Clear System environment variables (if elevated)
      if (isElevated()) {
        for (const name of userVars) {
          try {
            execSync(`reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v ${name} /f`, { stdio: 'ignore' });
            clearedSystem = true;
          } catch { /* may not exist */ }
        }
      }

      if (clearedUser || clearedSystem) {
        ok('Removed environment variables (HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS) from registry');
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
      const cleaned = removeIdeProxy(fs.readFileSync(p, 'utf8'));
      if (cleaned !== null) {
        fs.writeFileSync(p, cleaned, 'utf8');
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
  const purge = args.includes('--purge');

  const config = await loadConfig();
  const llmfwDir = getLlmFwDir();
  const elevated = isElevated();

  console.log('llm-fw uninstall — this reverses every change made by setup:');
  console.log('  • removes the root CA from the OS trust store, and the CA from ~/.llm-fw');
  console.log(purge
    ? '  • --purge: also deletes your settings, false-positive lists and audit log (keeps the licence key)'
    : '  • keeps your settings, false-positive lists, audit log and licence key (--purge deletes all but the licence)');
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
  await stopRunningProxy(llmfwDir);

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
  removeLlmfwFiles(llmfwDir, { keepModel, purge });
  removeEnvVars();
  removeIdeProxySettings();

  // 4. Remind about the env vars setup told the user to set (we don't own them).
  console.log('\n── Active shell sessions ───────────────────────────────────────────────────');
  console.log('  Environment variables were removed from registry/profiles, but active shell');
  console.log('  sessions still retain them. To clean your current session, run:');
  if (platform() === 'win32') {
    console.log("    Remove-Item Env:HTTPS_PROXY, Env:NO_PROXY, Env:NODE_EXTRA_CA_CERTS   # current session");
  } else {
    console.log("    unset HTTPS_PROXY NO_PROXY NODE_EXTRA_CA_CERTS                  # current session");
  }
  console.log('\n  Note: the Windows IP Helper service (iphlpsvc) and any Ollama judge model are');
  console.log('  shared system resources and are left in place. Remove them yourself if unused:');
  console.log('    ollama rm <model>');

  console.log('\nllm-fw uninstall complete.');
}
