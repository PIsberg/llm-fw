import forge from 'node-forge';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const LLMFW_DIR = process.env.LLM_FW_DIR || join(homedir(), '.llm-fw');
const CA_CERT_PATH = join(LLMFW_DIR, 'ca.crt');
const CA_KEY_PATH = join(LLMFW_DIR, 'ca.key');
export const CRL_PATH = join(LLMFW_DIR, 'ca.crl');
const DASHBOARD_PORT = 7731

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

// Build the ASN.1 for a cRLDistributionPoints extension (OID 2.5.29.31)
// containing a single distributionPoint with a fullName URI.
function makeCdpExtension(crlUrl: string): object {
  const uri = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 6, false,
    Buffer.from(crlUrl).toString('binary'))
  const fullName = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [uri])
  const dpName = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [fullName])
  const distPoint = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [dpName])
  const cdpSeq = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [distPoint])
  return { id: '2.5.29.31', critical: false, value: cdpSeq }
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
      makeCdpExtension(`http://127.0.0.1:${DASHBOARD_PORT}/crl`),
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

  // Generate an empty CRL signed by the CA and write it to ~/.llm-fw/ca.crl.
  // Schannel (Windows) checks the CRL Distribution Point in every cert; without
  // a reachable CRL it reports "revocation status unknown" and rejects the cert.
  generateAndSaveCRL(): void {
    const ca = this.getOrLoadCA()

    const now = new Date()
    const nextUpdate = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000)
    const pad2 = (n: number) => n.toString().padStart(2, '0')
    const utcTime = (d: Date) =>
      pad2(d.getUTCFullYear() % 100) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z'

    // sha256WithRSAEncryption
    const algId = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
        forge.asn1.oidToDer('1.2.840.113549.1.1.11').getBytes()),
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
    ])

    // Re-use the issuer ASN.1 from the CA cert verbatim (preserves exact byte encoding).
    // TBSCertificate layout (with explicit version): [version, serial, sigAlg, issuer, ...]
    const caCertAsn1 = forge.pki.certificateToAsn1(ca.cert)
    const issuerAsn1 = (caCertAsn1.value[0] as { value: forge.asn1.Asn1[] }).value[3]

    // TBSCertList (no revokedCertificates → empty CRL)
    const tbsCertList = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      algId,
      issuerAsn1,
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.UTCTIME, false, utcTime(now)),
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.UTCTIME, false, utcTime(nextUpdate)),
    ])

    const tbsDer = forge.asn1.toDer(tbsCertList)
    const md = forge.md.sha256.create()
    md.update(tbsDer.getBytes())
    const sigBytes = ca.key.sign(md)

    const crlAsn1 = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      tbsCertList,
      algId,
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.BITSTRING, false,
        '\x00' + sigBytes),
    ])

    fs.writeFileSync(CRL_PATH, Buffer.from(forge.asn1.toDer(crlAsn1).getBytes(), 'binary'))
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
      makeCdpExtension(`http://127.0.0.1:${DASHBOARD_PORT}/crl`),
    ]);

    cert.sign(ca.key, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    const credentials: TLSCredentials = { cert: certPem, key: keyPem };
    this.certCache.set(hostname, credentials);

    return credentials;
  }
}
