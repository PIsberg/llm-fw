import forge from 'node-forge';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const LLMFW_DIR = process.env.LLM_FW_DIR || join(homedir(), '.llm-fw');
const CA_CERT_PATH = join(LLMFW_DIR, 'ca.crt');
const CA_KEY_PATH = join(LLMFW_DIR, 'ca.key');

export interface TLSCredentials { cert: string; key: string }

export class CertFactory {
  private caForge: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } | null = null;
  private certCache = new Map<string, TLSCredentials>();

  generateCA(): TLSCredentials {
    fs.mkdirSync(LLMFW_DIR, { recursive: true });
    if (platform() !== 'win32') {
      fs.chmodSync(LLMFW_DIR, 0o700);
    }

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
