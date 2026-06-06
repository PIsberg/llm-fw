import { CertFactory } from '../proxy/certs.js';
import { EmbeddingChecker } from '../detection/embedding.js';
import { loadConfig } from '../config/config.js';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/** True when the current process can modify the hosts file / OS port redirects. */
export function isElevated(): boolean {
  if (platform() === 'win32') {
    try {
      // `net session` succeeds only for an elevated (admin) token.
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  // POSIX: root is uid 0.
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Resolve existing settings.json paths for VS Code and Antigravity IDE on the host. */
export function getIdeSettingsPaths(): string[] {
  const os = platform();
  const paths: string[] = [];

  if (os === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    paths.push(
      join(appData, 'Antigravity IDE', 'User', 'settings.json'),
      join(appData, 'Code', 'User', 'settings.json')
    );
  } else if (os === 'darwin') {
    paths.push(
      join(homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User', 'settings.json'),
      join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    );
  } else {
    paths.push(
      join(homedir(), '.config', 'Antigravity IDE', 'User', 'settings.json'),
      join(homedir(), '.config', 'Code', 'User', 'settings.json')
    );
  }

  return paths.filter(p => fs.existsSync(p));
}

/** Inject proxy configuration settings to detect and direct IDE network traffic. */
function configureIdeProxies(proxyUrl: string): void {
  const paths = getIdeSettingsPaths();
  let modifiedAny = false;

  for (const p of paths) {
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(p)) {
        try {
          config = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
        } catch {
          // corrupt JSON, start fresh or skip
          continue;
        }
      }

      let changed = false;
      if (config['http.proxy'] !== proxyUrl) {
        config['http.proxy'] = proxyUrl;
        changed = true;
      }
      if (config['http.proxyStrictSSL'] !== false) {
        config['http.proxyStrictSSL'] = false;
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(p, JSON.stringify(config, null, 4), 'utf8');
        modifiedAny = true;
      }
    } catch { /* ignore individual write/read errors */ }
  }

  if (modifiedAny) {
    console.log('  ✓ Configured proxy settings in IDE configurations (settings.json).');
  }
}

/**
 * Idempotently add the llm-fw `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` exports to a
 * shell-profile's text. Any previous llm-fw block (marker + loopback proxy /
 * `.llm-fw/ca.crt` exports) is stripped first, so re-running setup never stacks
 * duplicates. Pure (no I/O) so it can be unit-tested; the inverse lives in
 * `uninstall.stripProfileEnvVars`.
 */
export function addProfileEnvVars(profileContent: string, proxyUrl: string): string {
  const kept = profileContent.split(/\r?\n/).filter(line => {
    const t = line.trim();
    if (t === '# llm-fw env') return false;
    if (t.startsWith('export HTTPS_PROXY=') && (t.includes('127.0.0.1:') || t.includes('localhost:'))) return false;
    if (t.startsWith('export NODE_EXTRA_CA_CERTS=') && t.includes('.llm-fw/ca.crt')) return false;
    return true;
  }).join('\n').replace(/\n+$/, '');

  const block = `# llm-fw env\nexport HTTPS_PROXY=${proxyUrl}\nexport NODE_EXTRA_CA_CERTS="$HOME/.llm-fw/ca.crt"\n`;
  return (kept ? kept + '\n\n' : '') + block;
}

/**
 * Persist `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` so every new shell points at
 * the firewall without the user exporting anything by hand. Windows writes them
 * to the user environment (HKCU) via `setx`; POSIX appends to the shell profile.
 * `uninstall` reverses both (`removeEnvVars` / `stripProfileEnvVars`). Best-effort:
 * a failure prints a warning rather than aborting setup.
 */
function configureEnvVars(proxyUrl: string, caCertPath: string): void {
  const os = platform();
  try {
    if (os === 'win32') {
      // setx writes HKCU\Environment and broadcasts WM_SETTINGCHANGE, so new
      // terminals inherit the values (the current one must be reopened). Store
      // the resolved CA path — setx creates REG_SZ, which does not expand %VARS%.
      execFileSync('setx', ['HTTPS_PROXY', proxyUrl], { stdio: 'ignore' });
      execFileSync('setx', ['NODE_EXTRA_CA_CERTS', caCertPath], { stdio: 'ignore' });
      console.log('  ✓ Set HTTPS_PROXY + NODE_EXTRA_CA_CERTS in your user environment (open a new terminal to load them).');
    } else {
      const shell = process.env.SHELL || '';
      const profile = shell.includes('zsh') ? join(homedir(), '.zshrc')
        : shell.includes('bash') ? join(homedir(), '.bashrc')
        : (['.zshrc', '.bashrc', '.profile', '.bash_profile']
            .map(p => join(homedir(), p)).find(p => fs.existsSync(p)) || join(homedir(), '.profile'));
      const prev = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';
      fs.writeFileSync(profile, addProfileEnvVars(prev, proxyUrl), 'utf8');
      console.log(`  ✓ Added HTTPS_PROXY + NODE_EXTRA_CA_CERTS to ${profile} (run "source ${profile}" or open a new shell).`);
    }
  } catch (err) {
    console.warn('  ⚠ Could not set environment variables automatically: ' + (err as Error).message);
  }
}

export async function run(args: string[]): Promise<void> {
  // Sinkhole (OS-level redirect, covers Node.js/native tools that ignore
  // HTTPS_PROXY) is enabled by DEFAULT alongside the proxy so the firewall just
  // works with every tool — the user never has to pick a mode. It needs
  // admin/root; without it we set up proxy mode and explain how to enable the
  // sinkhole. `--proxy-only` opts out; `--sinkhole` is an explicit synonym for
  // the default.
  const proxyOnly = args.includes('--proxy-only');
  const elevated = isElevated();
  const sinkhole = !proxyOnly && elevated;
  const sinkholeWanted = !proxyOnly;
  const llmfwDir = join(homedir(), '.llm-fw');
  const caCertPath = join(llmfwDir, 'ca.crt');

  console.log('Setting up llm-fw...');

  // Step 1 - Generate CA
  const certFactory = new CertFactory();
  certFactory.generateCA();
  console.log('CA certificate generated.');
  certFactory.generateAndSaveCRL();
  console.log('CRL generated.');

  // Step 2 - Install to OS trust store
  try {
    const os = platform();
    if (os === 'win32') {
      execSync('certutil -addstore -f Root "' + caCertPath + '"');
    } else if (os === 'darwin') {
      execSync('security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "' + caCertPath + '"');
    } else {
      fs.copyFileSync(caCertPath, '/usr/local/share/ca-certificates/llm-fw-ca.crt');
      execSync('update-ca-certificates');
    }
    console.log('CA certificate installed to OS trust store.');
  } catch {
    console.warn('Could not install CA automatically. To trust the certificate manually:');
    console.warn('  Certificate path:', caCertPath);
    console.warn('  Windows: certutil -addstore -f Root "' + caCertPath + '"');
    console.warn('  macOS:   security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "' + caCertPath + '"');
    console.warn('  Linux:   copy to /usr/local/share/ca-certificates/ and run update-ca-certificates');
  }

  // Step 3 - Download/init embedding model
  const config = await loadConfig();
  const checker = new EmbeddingChecker(config.detection);
  console.log('Downloading embedding model (this may take a moment)...');
  await checker.init();
  console.log(checker.isInitialized()
    ? 'Embedding model ready.'
    : 'Embedding model could not be downloaded — the semantic stage stays disabled until it is reachable (all other stages are unaffected). Re-run setup to retry.');

  // Step 4 - Sinkhole hosts file + port forwarding
  if (sinkhole) {
    const hostsPath = platform() === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts';
    const config = await loadConfig();
    try {
      const original = fs.readFileSync(hostsPath, 'utf8');
      const lines = original.split(/\r?\n/);
      const cleanLines = [];
      let inBlock = false;
      const targetHosts = new Set(config.targets);
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '# llm-fw sinkhole') {
          inBlock = true;
          continue;
        }
        if (inBlock) {
          if (trimmed === '' || (!trimmed.startsWith('127.0.0.1') && !trimmed.startsWith('::1') && !trimmed.startsWith('#'))) {
            inBlock = false; // heuristic for end of block
          } else {
            continue;
          }
        }
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2 && targetHosts.has(parts[1])) continue;
        cleanLines.push(line);
      }
      
      const cleanHosts = cleanLines.join('\n');
      if (original !== cleanHosts) {
        fs.writeFileSync(hostsPath + '.llm-fw.bak', original, 'utf8');
      } else if (!fs.existsSync(hostsPath + '.llm-fw.bak')) {
        fs.writeFileSync(hostsPath + '.llm-fw.bak', original, 'utf8');
      }
      
      const hostLines = config.targets.map(t => `127.0.0.1 ${t}`).join('\n');
      const entries = (cleanHosts.endsWith('\n') || cleanHosts === '' ? '' : '\n') + `# llm-fw sinkhole\n${hostLines}\n`;
      fs.writeFileSync(hostsPath, cleanHosts + entries, 'utf8');
      console.log('Sinkhole entries added to hosts file.');
    } catch (err) {
      console.error('Failed to modify hosts file. Try running with administrator/root privileges.');
      console.error((err as Error).message);
    }

    // Redirect 127.0.0.1:443 → 127.0.0.1:httpsPort so the sinkhole TLS server
    // can run on an unprivileged port.
    const os = platform();
    if (os === 'win32') {
      try {
        // The IP Helper service is required for portproxy to function.
        execSync('sc config iphlpsvc start= auto', { stdio: 'ignore' });
        execSync('net start iphlpsvc', { stdio: 'ignore' });
      } catch {
        // Ignore if already running or if we lack permissions, though we should be elevated here.
      }
      try {
        execFileSync('netsh', [
          'interface', 'portproxy', 'add', 'v4tov4',
          'listenport=443', 'listenaddress=127.0.0.1',
          `connectport=${config.proxy.httpsPort}`, 'connectaddress=127.0.0.1',
        ], { stdio: 'ignore' });
        execFileSync('netsh', [
          'interface', 'portproxy', 'add', 'v6tov4',
          'listenport=443', 'listenaddress=::1',
          `connectport=${config.proxy.httpsPort}`, 'connectaddress=127.0.0.1',
        ], { stdio: 'ignore' });
        console.log(`Port proxy: 127.0.0.1:443 and [::1]:443 → 127.0.0.1:${config.proxy.httpsPort}`);
      } catch (err) {
        console.warn('Could not add port proxy rule (requires admin):', (err as Error).message);
      }
    } else if (os === 'darwin') {
      try {
        execSync(
          `echo "rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${config.proxy.httpsPort}" | pfctl -ef -`,
          { stdio: 'pipe' }
        );
        console.log(`pf redirect: lo0:443 → ${config.proxy.httpsPort}`);
      } catch (err) {
        console.warn('Could not add pf redirect (requires sudo):', (err as Error).message);
      }
    } else {
      try {
        execSync(
          `iptables -t nat -A OUTPUT -o lo -p tcp --dport 443 -j REDIRECT --to-port ${config.proxy.httpsPort}`,
          { stdio: 'pipe' }
        );
        console.log(`iptables redirect: lo:443 → ${config.proxy.httpsPort}`);
      } catch (err) {
        console.warn('Could not add iptables redirect (requires sudo):', (err as Error).message);
      }
    }

    // Persist sinkhole mode so `llm-fw start` picks it up without extra env vars.
    fs.writeFileSync(
      join(llmfwDir, 'config.json'),
      JSON.stringify({ proxy: { mode: 'sinkhole' } }, null, 2),
      'utf8'
    );
    console.log('Sinkhole mode saved to config.');
  } else {
    // Proxy-only: either the user opted out, or we lack the privileges to set up
    // the sinkhole. Persist proxy mode so `start` and `status` are accurate.
    fs.writeFileSync(
      join(llmfwDir, 'config.json'),
      JSON.stringify({ proxy: { mode: 'proxy' } }, null, 2),
      'utf8'
    );
  }

  // Configure IDE proxy settings + persist the proxy/CA env vars so new shells
  // are covered automatically (reversed by uninstall).
  const proxyUrl = 'http://127.0.0.1:' + config.proxy.port;
  configureIdeProxies(proxyUrl);
  configureEnvVars(proxyUrl, caCertPath);

  console.log('\nllm-fw setup complete.');

  // Tell the user exactly which coverage is active, and how to unlock the rest.
  console.log('\n── Coverage ────────────────────────────────────────────────────────────────');
  if (sinkhole) {
    console.log('  ✓ Proxy mode    — tools that honour HTTPS_PROXY (curl, Python, Go, …)');
    console.log('  ✓ Sinkhole mode — Node.js & native tools (Claude Code, SDKs, …) — no proxy env needed');
  } else if (sinkholeWanted && !elevated) {
    console.log('  ✓ Proxy mode    — tools that honour HTTPS_PROXY (curl, Python, Go, …)');
    console.log('  ✗ Sinkhole mode — SKIPPED (needs admin/root). Re-run setup elevated to also');
    console.log('    cover Node.js & native tools (Claude Code, SDKs) without proxy env vars:');
    if (platform() === 'win32') {
      console.log('      Right-click your terminal → "Run as Administrator", then: llm-fw setup');
    } else {
      console.log('      sudo llm-fw setup');
    }
  } else {
    console.log('  ✓ Proxy mode    — tools that honour HTTPS_PROXY (curl, Python, Go, …)');
    console.log('    (sinkhole skipped via --proxy-only; omit it to also cover Node.js/native tools)');
  }

  // Env var instructions (OS-specific). What's needed depends on the mode:
  // sinkhole redirects at the OS level (no HTTPS_PROXY), so Node/native tools
  // only need the CA trusted; proxy-only needs HTTPS_PROXY set per terminal.
  const os = platform();
  const caCert = join(llmfwDir, 'ca.crt');
  if (sinkhole) {
    console.log('\n── Point your tools at llm-fw ──────────────────────────────────────────────');
    console.log('  Sinkhole is active — traffic is redirected at the OS level, so HTTPS_PROXY');
    console.log('  is not strictly required; setup set it anyway for proxy-aware tools.');
    console.log('  HTTPS_PROXY + NODE_EXTRA_CA_CERTS were set persistently (see ✓ above).');
  } else {
    console.log('\n── Point your tools at the proxy ───────────────────────────────────────────');
    console.log('  HTTPS_PROXY + NODE_EXTRA_CA_CERTS were set persistently (see ✓ above), so new');
    console.log('  terminals are covered automatically — no per-terminal exports needed.');
  }
  console.log('\n  To load them into THIS terminal (or any already-open shell) right now:\n');
  if (os === 'win32') {
    console.log('    PowerShell:      $env:HTTPS_PROXY="' + proxyUrl + '"; $env:NODE_EXTRA_CA_CERTS="' + caCert + '"');
    console.log('    Command Prompt:  set HTTPS_PROXY=' + proxyUrl + ' ^& set NODE_EXTRA_CA_CERTS=' + caCert);
  } else {
    console.log('    export HTTPS_PROXY=' + proxyUrl + ' NODE_EXTRA_CA_CERTS="' + caCert + '"');
  }
  console.log('\n  Then (re)start your LLM tool so it opens a fresh connection.');

  // Optional: Stage 3 judge setup
  console.log('\n── Stage 3: Ollama Judge (optional) ────────────────────────────────────────');
  console.log('  Stages 1 and 2 catch most injections, but can be bypassed by encoding,');
  console.log('  foreign languages, roleplay framing, and other techniques a regex or');
  console.log('  similarity check cannot reason about. Stage 3 adds a local LLM judge');
  console.log('  (via Ollama) that evaluates the intent of each prompt — closing those gaps.');

  const rl = createInterface({ input, output });
  const answer = await rl.question('\n  Set up Stage 3 now? [y/N]: ');
  rl.close();

  if (answer.trim().toLowerCase() === 'y') {
    const { run: runSetupJudge } = await import('./setup-judge.js');
    await runSetupJudge();
  } else {
    console.log('\n  Skipped. Run "llm-fw setup-judge" at any time to enable it.');
    console.log('  Run "llm-fw start" to begin.\n');
  }
}
