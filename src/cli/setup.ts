import { CertFactory } from '../proxy/certs.js';
import { EmbeddingChecker } from '../detection/embedding.js';
import { loadConfig } from '../config/config.js';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

export async function run(args: string[]): Promise<void> {
  const sinkhole = args.includes('--sinkhole');
  const llmfwDir = join(homedir(), '.llm-fw');
  const caCertPath = join(llmfwDir, 'ca.crt');

  console.log('Setting up llm-fw...');

  // Step 1 - Generate CA
  new CertFactory().generateCA();
  console.log('CA certificate generated.');

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
  } catch (err) {
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

  // Step 4 - Sinkhole hosts file
  if (sinkhole) {
    const hostsPath = platform() === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts';
    try {
      const original = fs.readFileSync(hostsPath, 'utf8');
      fs.writeFileSync(hostsPath + '.llm-fw.bak', original, 'utf8');
      const entries = '\n# llm-fw sinkhole\n127.0.0.1 llm-fw.invalid\n127.0.0.1 sinkhole.llm-fw.invalid\n';
      fs.appendFileSync(hostsPath, entries, 'utf8');
      console.log('Sinkhole entries added to hosts file. Backup saved to', hostsPath + '.llm-fw.bak');
    } catch (err) {
      console.error('Failed to modify hosts file. Try running with administrator/root privileges.');
      console.error((err as Error).message);
    }
  }

  console.log('\nllm-fw setup complete. Run "llm-fw start" to begin.');
}
