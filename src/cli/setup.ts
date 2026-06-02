import { CertFactory } from '../proxy/certs.js';
import { EmbeddingChecker } from '../detection/embedding.js';
import { loadConfig } from '../config/config.js';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function run(args: string[]): Promise<void> {
  const sinkhole = args.includes('--sinkhole');
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
  console.log('Embedding model ready.');

  // Step 4 - Sinkhole hosts file + port forwarding
  if (sinkhole) {
    const hostsPath = platform() === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts';
    const config = await loadConfig();
    try {
      const original = fs.readFileSync(hostsPath, 'utf8');
      fs.writeFileSync(hostsPath + '.llm-fw.bak', original, 'utf8');
      const hostLines = config.targets.map(t => `127.0.0.1 ${t}\n::1 ${t}`).join('\n');
      const entries = `\n# llm-fw sinkhole\n${hostLines}\n`;
      fs.appendFileSync(hostsPath, entries, 'utf8');
      console.log('Sinkhole entries added to hosts file. Backup saved to', hostsPath + '.llm-fw.bak');
    } catch (err) {
      console.error('Failed to modify hosts file. Try running with administrator/root privileges.');
      console.error((err as Error).message);
    }

    // Redirect 127.0.0.1:443 → 127.0.0.1:httpsPort so the sinkhole TLS server
    // can run on an unprivileged port.
    const os = platform();
    if (os === 'win32') {
      try {
        execFileSync('netsh', [
          'interface', 'portproxy', 'add', 'v4tov4',
          'listenport=443', 'listenaddress=127.0.0.1',
          `connectport=${config.proxy.httpsPort}`, 'connectaddress=127.0.0.1',
        ], { stdio: 'ignore' });
        console.log(`Port proxy: 127.0.0.1:443 → 127.0.0.1:${config.proxy.httpsPort}`);
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
  }

  console.log('\nllm-fw setup complete.');

  // Proxy env var instructions (OS-specific)
  const os = platform();
  const caCert = join(llmfwDir, 'ca.crt');
  console.log('\n── Point your tools at the proxy ───────────────────────────────────────────');
  console.log('  Run these in every terminal where you use LLM tools:\n');
  if (os === 'win32') {
    console.log('  PowerShell:');
    console.log('    $env:HTTPS_PROXY="http://127.0.0.1:8080"');
    console.log('    $env:NODE_EXTRA_CA_CERTS="' + caCert + '"  # Node.js clients only');
    console.log('\n  Command Prompt:');
    console.log('    set HTTPS_PROXY=http://127.0.0.1:8080');
  } else if (os === 'darwin') {
    console.log('  Terminal (bash / zsh):');
    console.log('    export HTTPS_PROXY=http://127.0.0.1:8080');
    console.log('    export NODE_EXTRA_CA_CERTS="' + caCert + '"  # Node.js clients only');
    console.log('\n  Add to ~/.zshrc or ~/.bashrc to make it permanent.');
  } else {
    console.log('  bash / zsh:');
    console.log('    export HTTPS_PROXY=http://127.0.0.1:8080');
    console.log('    export NODE_EXTRA_CA_CERTS="' + caCert + '"  # Node.js clients only');
    console.log('\n  Add to ~/.bashrc or ~/.profile to make it permanent.');
  }

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
