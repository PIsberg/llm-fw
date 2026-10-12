import forge from 'node-forge';
import { platform } from 'node:os';
import { getLlmFwDir } from '../config/paths.js';
import { reachableHost, urlHost } from '../config/net.js';
import { join } from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Resolved per call, like every other getLlmFwDir() consumer. Captured at module
// load they ignored an LLM_FW_DIR set afterwards, so the unit tests that set it
// in a hook wrote their CA over the developer's real ~/.llm-fw/ca.key.
const caCertPath = (): string => join(getLlmFwDir(), 'ca.crt');
const caKeyPath = (): string => join(getLlmFwDir(), 'ca.key');
const crlPath = (): string => join(getLlmFwDir(), 'ca.crl');

/** The dashboard port, which is where the CRL is served from. */
export const DEFAULT_DASHBOARD_PORT = 7731;

/**
 * Where a client should fetch the CRL for certificates this factory issues.
 *
 * This URL is baked into the CA and into every leaf, and it is load-bearing:
 * docs/ARCHITECTURE.md records that Windows Schannel rejects a leaf whose
 * revocation status it cannot determine. It used to be hardcoded to
 * `http://127.0.0.1:7731/crl`, which broke silently for anyone who moved the
 * dashboard port, and pointed a remote client at its own machine.
 *
 * A wildcard bind resolves to a reachable address rather than `0.0.0.0`, which
 * no client can fetch from.
 */
export function crlUrlFor(bindHost: string | undefined, port: number = DEFAULT_DASHBOARD_PORT): string {
  return `http://${urlHost(reachableHost(bindHost))}:${port}/crl`;
}

export interface TLSCredentials { cert: string; key: string }

/**
 * A random, positive 16-byte serial number as a hex string. The CA used to be
 * hardcoded to '01', so every regenerated CA was byte-indistinguishable by
 * (issuer, serial) from its predecessor — a stale trust anchor then surfaced as
 * an opaque CERT_SIGNATURE_FAILURE instead of a clean "unknown issuer". A unique
 * serial (paired with the subjectKeyIdentifier below) lets validators tell two
 * generations of the CA apart. The high bit is cleared so the DER INTEGER stays
 * positive.
 */
function randomSerial(): string {
  const b = randomBytes(16)
  // Clear the top bit so the serial is a positive integer. randomBytes(16)
  // always has index 0; the fallback restates that for the compiler.
  b[0] = (b[0] ?? 0) & 0x7f
  return b.toString('hex')
}

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
function cdpSequence(crlUrl: string): forge.asn1.Asn1 {
  const uri = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 6, false,
    Buffer.from(crlUrl).toString('binary'))
  const fullName = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [uri])
  const dpName = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [fullName])
  const distPoint = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [dpName])
  return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [distPoint])
}

function makeCdpExtension(crlUrl: string): object {
  return { id: '2.5.29.31', critical: false, value: cdpSequence(crlUrl) }
}

export class CertFactory {
  private caForge: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } | null = null;
  private certCache = new Map<string, TLSCredentials>();
  // Single shared key pair for all host certs — generated once, reused forever.
  // Generating a 2048-bit RSA pair per hostname blocks the event loop for 100-2000ms.
  private hostKeyPair: forge.pki.rsa.KeyPair | null = null;

  /**
   * @param crlUrl CRL distribution point embedded in the CA and in every leaf.
   *   Defaults to loopback on the default dashboard port, which is what a
   *   single-machine install wants. A server whose dashboard moved, or one
   *   serving remote clients, passes its own reachable URL (see `crlUrlFor`).
   */
  constructor(private readonly crlUrl: string = crlUrlFor(undefined)) {}

  /** Pre-generate the shared host key during setup so getHostCert never blocks mid-request. */
  warmHostKey(): void {
    if (!this.hostKeyPair) {
      this.hostKeyPair = forge.pki.rsa.generateKeyPair(2048);
    }
  }

  /**
   * Keep the CA already on disk when it is still usable, otherwise make one.
   *
   * Every client, container and machine that trusts the CA breaks when it is
   * replaced, so `llm-fw setup` must not replace it just because it ran again
   * (it tells a non-admin user to re-run it elevated). Usable means: both files
   * load, the key belongs to the certificate, it has not expired, and its CRL
   * distribution point is the one this install serves, since that URL is baked
   * into the CA and Windows Schannel rejects leaves whose CRL it cannot fetch.
   */
  ensureCA(): 'reused' | 'generated' {
    try {
      this.loadCA();
      const { cert, key } = this.caForge!;
      const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
      const cdp = cert.extensions.find((e: { id?: string }) => e.id === '2.5.29.31') as { value?: string } | undefined;
      const usable = publicKey.n.equals(key.n)
        && cert.validity.notAfter.getTime() > Date.now()
        && cdp?.value === forge.asn1.toDer(cdpSequence(this.crlUrl)).getBytes();
      if (usable) return 'reused';
    } catch { /* missing or unreadable: make a new one */ }
    this.caForge = null;
    this.generateCA();
    return 'generated';
  }

  generateCA(): TLSCredentials {
    const dir = getLlmFwDir();
    fs.mkdirSync(dir, { recursive: true });
    restrictDirPermissions(dir);

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();

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
      // Identifies this CA's key. Leaf certs carry a matching
      // authorityKeyIdentifier, so when two generations of "llm-fw Local CA"
      // are trusted at once a validator selects the right one by key id rather
      // than picking one by name and failing the signature check.
      { name: 'subjectKeyIdentifier' },
      makeCdpExtension(this.crlUrl),
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    fs.writeFileSync(caCertPath(), certPem, { encoding: 'utf8' });
    fs.writeFileSync(caKeyPath(), keyPem, { encoding: 'utf8' });

    this.caForge = { cert, key: keys.privateKey };
    // Pre-warm shared host key while RSA generation is already on the critical path during setup.
    this.warmHostKey();

    return { cert: certPem, key: keyPem };
  }

  loadCA(): TLSCredentials {
    const certPem = fs.readFileSync(caCertPath(), 'utf8');
    const keyPem = fs.readFileSync(caKeyPath(), 'utf8');

    const cert = forge.pki.certificateFromPem(certPem);
    const key = forge.pki.privateKeyFromPem(keyPem);

    this.caForge = { cert, key };

    return { cert: certPem, key: keyPem };
  }

  getOrLoadCA(): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } {
    if (this.caForge) return this.caForge;

    if (fs.existsSync(caCertPath())) {
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
    // Index 3 of the TBSCertificate is the issuer Name. A CA cert that does
    // not have one is not a CA cert, and a CRL built from a guess would be
    // signed and served to every client, so refuse rather than improvise.
    const issuerAsn1 = (caCertAsn1.value[0] as { value: forge.asn1.Asn1[] }).value[3]
    if (!issuerAsn1) throw new Error('CA certificate has no issuer field; cannot build a CRL')

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

    fs.writeFileSync(crlPath(), Buffer.from(forge.asn1.toDer(crlAsn1).getBytes(), 'binary'))
  }

  getHostCert(hostname: string): TLSCredentials {
    const cached = this.certCache.get(hostname);
    if (cached) return cached;

    const ca = this.getOrLoadCA();

    // Reuse the single pre-generated host key pair — never block the event loop per hostname.
    this.warmHostKey();
    const keys = this.hostKeyPair!;
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
      // Bind this leaf to the CA's key id + serial. forge would otherwise
      // derive these from the leaf itself (options.cert), so the CA's values
      // are passed explicitly. This is what lets a client distinguish a leaf
      // signed by the current CA from one signed by a rotated-out predecessor.
      {
        name: 'authorityKeyIdentifier',
        keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes(),
        authorityCertIssuer: true,
        serialNumber: ca.cert.serialNumber,
      },
      makeCdpExtension(this.crlUrl),
    ]);

    cert.sign(ca.key, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    const credentials: TLSCredentials = { cert: certPem, key: keyPem };
    this.certCache.set(hostname, credentials);

    return credentials;
  }
}
