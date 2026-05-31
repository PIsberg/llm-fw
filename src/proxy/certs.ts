import forge from 'node-forge';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const LLMFW_DIR = process.env.LLM_FW_DIR || join(homedir(), '.llm-fw');
const CA_CERT_PATH = join(LLMFW_DIR, 'ca.crt');
const CA_KEY_PATH = join(LLMFW_DIR, 'ca.key');

export interface TLSCredentials { cert: string; key: string }

/**
 * Restrict the llm-fw directory so only the current user can read it. The
 * directory holds the root CA private key, which is installed into the system
 * trust store — if any local process under the same machine could read it, that
 * process could transparently MITM all the user's HTTPS traffic.
 *
 * On POSIX a 0700 chmod suffices. On Windows, files inherit folder ACLs and
 * chmod is a no-op, so we use icacls to remove inheritance and grant access to
 * the current user (and SYSTEM) only.
 */
export function restrictDirPermissions(dir: string): void {
  if (platform() !== 'win32') {
    fs.chmodSync(dir, 0o700);
    return;
  }
  const user = process.env.USERNAME;
  if (!user) return; // can't identify the owner; leave default ACLs
  // /inheritance:r  → drop inherited ACEs
  // /grant:r        → replace, granting full control to the named principals only
  execFileSync(
    'icacls',
    [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/grant:r', 'SYSTEM:(OI)(CI)F'],
    { stdio: 'ignore' }
  );
}

export class CertFactory {
  private caForge: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } | null = null;
  private certCache = new Map<string, TLSCredentials>();

  generateCA(): TLSCredentials {
    fs.mkdirSync(LLMFW_DIR, { recursive: true });
    restrictDirPermissions(LLMFW_DIR);

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';

    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + 10);
    cert.validity.notBefore = notBefore;
    cert.validity.notAfter = notAfter;

    const attrs = [
      { name: 'commonName', value: 'llm-fw Local CA' },
      { name: 'organizationName', value: 'llm-fw' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    fs.writeFileSync(CA_CERT_PATH, certPem, { encoding: 'utf8' });
    fs.writeFileSync(CA_KEY_PATH, keyPem, { encoding: 'utf8' });

    this.caForge = { cert, key: keys.privateKey };

    return { cert: certPem, key: keyPem };
  }

  loadCA(): TLSCredentials {
    const certPem = fs.readFileSync(CA_CERT_PATH, 'utf8');
    const keyPem = fs.readFileSync(CA_KEY_PATH, 'utf8');

    const cert = forge.pki.certificateFromPem(certPem);
    const key = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;

    this.caForge = { cert, key };

    return { cert: certPem, key: keyPem };
  }

  getOrLoadCA(): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } {
    if (this.caForge) return this.caForge;

    if (fs.existsSync(CA_CERT_PATH)) {
      this.loadCA();
      return this.caForge!;
    }

    throw new Error('CA not found. Run: llm-fw setup');
  }

  getHostCert(hostname: string): TLSCredentials {
    const cached = this.certCache.get(hostname);
    if (cached) return cached;

    const ca = this.getOrLoadCA();

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomBytes(8).toString('hex');

    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + 1);
    cert.validity.notBefore = notBefore;
    cert.validity.notAfter = notAfter;

    cert.setSubject([{ name: 'commonName', value: hostname }]);
    cert.setIssuer(ca.cert.subject.attributes);

    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: hostname }],
      },
    ]);

    cert.sign(ca.key, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    const credentials: TLSCredentials = { cert: certPem, key: keyPem };
    this.certCache.set(hostname, credentials);

    return credentials;
  }
}
