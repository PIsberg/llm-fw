import { platform } from 'node:os';
import { getLlmFwDir } from '../config/paths.js';
import { reachableHost, urlHost } from '../config/net.js';
import { join } from 'node:path';
import fs from 'node:fs';
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  KeyObject,
  randomBytes,
  sign as cryptoSign,
  X509Certificate,
} from 'node:crypto';
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
 * A random, positive 16-byte serial number. The CA used to be hardcoded to '01',
 * so every regenerated CA was byte-indistinguishable by (issuer, serial) from
 * its predecessor — a stale trust anchor then surfaced as an opaque
 * CERT_SIGNATURE_FAILURE instead of a clean "unknown issuer". A unique serial
 * (paired with the subjectKeyIdentifier below) lets validators tell two
 * generations of the CA apart. The high bit is cleared so the DER INTEGER stays
 * positive.
 */
function randomPositiveSerial(byteLength: number): Buffer {
  const b = randomBytes(byteLength);
  b[0] = ((b[0] ?? 0) & 0x7f) || 0x01;
  return b;
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

// ── Minimal ASN.1 DER primitives (X.509 v3 + CRL v2, RFC 5280) ──────────────

function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len <= 0xff) return Buffer.from([0x81, len]);
  if (len <= 0xffff) return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derSeq(...items: Buffer[]): Buffer {
  return derTlv(0x30, Buffer.concat(items));
}

function derSet(...items: Buffer[]): Buffer {
  return derTlv(0x31, Buffer.concat(items));
}

function derExplicit(tagNum: number, inner: Buffer): Buffer {
  return derTlv(0xa0 | tagNum, inner);
}

function derImplicit(tagNum: number, content: Buffer, constructed = false): Buffer {
  return derTlv((constructed ? 0xa0 : 0x80) | tagNum, content);
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const bytes: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i] ?? 0;
    if (v === 0) {
      bytes.push(0);
      continue;
    }
    const sub: number[] = [];
    while (v > 0) {
      sub.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    }
    for (let j = 0; j < sub.length - 1; j++) sub[j] = (sub[j] ?? 0) | 0x80;
    bytes.push(...sub);
  }
  return derTlv(0x06, Buffer.from(bytes));
}

function decodeOid(buf: Buffer): string {
  if (buf.length === 0) return '';
  const b0 = buf[0]!;
  const arcs: number[] = b0 >= 80 ? [2, b0 - 80] : [Math.floor(b0 / 40), b0 % 40];
  let acc = 0;
  for (let i = 1; i < buf.length; i++) {
    const b = buf[i]!;
    acc = acc * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      arcs.push(acc);
      acc = 0;
    }
  }
  return arcs.join('.');
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derBool(v: boolean): Buffer {
  return Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
}

function derPositiveInteger(raw: Buffer): Buffer {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0x00) start++;
  const slice = raw.subarray(start);
  const body = ((slice[0] ?? 0) & 0x80) !== 0 ? Buffer.concat([Buffer.from([0x00]), slice]) : slice;
  return derTlv(0x02, body);
}

function derOctetString(b: Buffer): Buffer {
  return derTlv(0x04, b);
}

function derBitString(b: Buffer, unusedBits = 0): Buffer {
  return derTlv(0x03, Buffer.concat([Buffer.from([unusedBits]), b]));
}

function derUtf8String(s: string): Buffer {
  return derTlv(0x0c, Buffer.from(s, 'utf8'));
}

function derTime(d: Date): Buffer {
  const pad2 = (n: number) => n.toString().padStart(2, '0');
  const year = d.getUTCFullYear();
  const tail =
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    'Z';
  // RFC 5280 §4.1.2.5: UTCTime for years through 2049, GeneralizedTime from 2050.
  if (year < 2050) {
    return derTlv(0x17, Buffer.from(pad2(year % 100) + tail, 'ascii'));
  }
  return derTlv(0x18, Buffer.from(year.toString() + tail, 'ascii'));
}

function derAlgSha256WithRsa(): Buffer {
  return derSeq(derOid('1.2.840.113549.1.1.11'), derNull());
}

function derName(attrs: Array<{ oid: string; value: string }>): Buffer {
  return derSeq(...attrs.map(a => derSet(derSeq(derOid(a.oid), derUtf8String(a.value)))));
}

function derExtension(oid: string, critical: boolean, extnValue: Buffer): Buffer {
  return critical
    ? derSeq(derOid(oid), derBool(true), derOctetString(extnValue))
    : derSeq(derOid(oid), derOctetString(extnValue));
}

function toPem(label: string, der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// Build the ASN.1 DER for a cRLDistributionPoints extension (OID 2.5.29.31)
// containing a single distributionPoint with a fullName URI.
function cdpSequence(crlUrl: string): Buffer {
  const uri = derImplicit(6, Buffer.from(crlUrl, 'ascii'), false);
  const fullName = derImplicit(0, uri, true);
  const dpName = derImplicit(0, fullName, true);
  const distPoint = derSeq(dpName);
  return derSeq(distPoint);
}

interface DerNode {
  tag: number;
  raw: Buffer;
  value: Buffer;
  nextOffset: number;
}

function readTlv(buf: Buffer, offset = 0): DerNode {
  if (offset >= buf.length) throw new Error('ASN.1 truncated tag');
  const tag = buf[offset]!;
  let pos = offset + 1;
  if (pos >= buf.length) throw new Error('ASN.1 truncated length');
  const firstLen = buf[pos++]!;
  let length = 0;
  if ((firstLen & 0x80) === 0) {
    length = firstLen;
  } else {
    const numBytes = firstLen & 0x7f;
    if (numBytes === 0 || numBytes > 4 || pos + numBytes > buf.length) {
      throw new Error('ASN.1 invalid length');
    }
    for (let i = 0; i < numBytes; i++) {
      length = (length << 8) | buf[pos++]!;
    }
  }
  const end = pos + length;
  if (end > buf.length) throw new Error('ASN.1 value out of bounds');
  return {
    tag,
    raw: buf.subarray(offset, end),
    value: buf.subarray(pos, end),
    nextOffset: end,
  };
}

function readChildren(seqValue: Buffer): DerNode[] {
  const out: DerNode[] = [];
  let off = 0;
  while (off < seqValue.length) {
    const node = readTlv(seqValue, off);
    out.push(node);
    off = node.nextOffset;
  }
  return out;
}

/**
 * Compute RFC 5280 method-1 Subject Key Identifier (20-byte SHA-1 of the
 * subjectPublicKey BIT STRING value inside SubjectPublicKeyInfo).
 */
export function computeSubjectKeyIdentifier(publicKey: KeyObject): Buffer {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const spkiChildren = readChildren(readTlv(spkiDer, 0).value);
  const bitString = spkiChildren[1];
  if (!bitString || bitString.tag !== 0x03 || bitString.value.length < 2) {
    throw new Error('Invalid SubjectPublicKeyInfo BIT STRING');
  }
  return createHash('sha1').update(bitString.value.subarray(1)).digest();
}

interface ParsedCaDer {
  serialBytes: Buffer;
  issuerDer: Buffer;
  subjectDer: Buffer;
  extensions: Map<string, Buffer>;
}

function parseCaDer(certDer: Buffer): ParsedCaDer {
  const certChildren = readChildren(readTlv(certDer, 0).value);
  const tbsNode = certChildren[0];
  if (!tbsNode || tbsNode.tag !== 0x30) throw new Error('Invalid X.509 TBSCertificate');
  const tbs = readChildren(tbsNode.value);
  const hasExplicitVersion = tbs[0]?.tag === 0xa0;
  const idx = hasExplicitVersion ? 1 : 0;
  const serialNode = tbs[idx];
  const issuerNode = tbs[idx + 2];
  const subjectNode = tbs[idx + 4];
  if (!serialNode || !issuerNode || !subjectNode || issuerNode.tag !== 0x30 || subjectNode.tag !== 0x30) {
    throw new Error('CA certificate missing required TBSCertificate fields');
  }

  const extensions = new Map<string, Buffer>();
  const extWrapper = tbs.find(n => n.tag === 0xa3);
  if (extWrapper) {
    const extSeq = readTlv(extWrapper.value, 0);
    for (const extNode of readChildren(extSeq.value)) {
      const parts = readChildren(extNode.value);
      const oidNode = parts[0];
      const valNode = parts[parts.length - 1];
      if (oidNode?.tag === 0x06 && valNode?.tag === 0x04) {
        extensions.set(decodeOid(oidNode.value), valNode.value);
      }
    }
  }

  return {
    serialBytes: serialNode.value,
    issuerDer: issuerNode.raw,
    subjectDer: subjectNode.raw,
    extensions,
  };
}

/**
 * Parse the X.509 v3 extensions map (OID -> raw extnValue OCTET STRING bytes)
 * from a DER-encoded certificate.
 */
export function parseCertificateExtensions(certDer: Buffer): Map<string, Buffer> {
  return parseCaDer(certDer).extensions;
}

interface KeyPairState {
  publicKey: KeyObject;
  privateKey: KeyObject;
  keyPem: string;
}

function generateRsa2048(): KeyPairState {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  return { publicKey, privateKey, keyPem };
}

function signX509Tbs(tbsDer: Buffer, signingKey: KeyObject): string {
  const sig = cryptoSign('sha256', tbsDer, signingKey);
  const certDer = derSeq(tbsDer, derAlgSha256WithRsa(), derBitString(sig, 0));
  return toPem('CERTIFICATE', certDer);
}

/** Issue an in-memory self-signed CA certificate and private key PEM pair. */
export function issueInMemoryCA(commonName = 'llm-fw Local CA', crlUrl?: string): TLSCredentials {
  const keys = generateRsa2048();
  const serial = randomPositiveSerial(16);
  const now = new Date();
  const notAfter = new Date(now.getTime());
  notAfter.setFullYear(notAfter.getFullYear() + 10);

  const nameDer = derName([
    { oid: '2.5.4.3', value: commonName },
    { oid: '2.5.4.10', value: 'llm-fw' },
  ]);
  const spkiDer = keys.publicKey.export({ type: 'spki', format: 'der' });
  const skiBytes = computeSubjectKeyIdentifier(keys.publicKey);

  const exts: Buffer[] = [
    // basicConstraints: cA=TRUE
    derExtension('2.5.29.19', true, derSeq(derBool(true))),
    // keyUsage: keyCertSign (bit 5) | cRLSign (bit 6) => 0x06, 1 unused bit
    derExtension('2.5.29.15', true, derBitString(Buffer.from([0x06]), 1)),
    // subjectKeyIdentifier: OCTET STRING of 20-byte SHA-1
    derExtension('2.5.29.14', false, derOctetString(skiBytes)),
  ];
  if (crlUrl) {
    exts.push(derExtension('2.5.29.31', false, cdpSequence(crlUrl)));
  }

  const tbsDer = derSeq(
    derExplicit(0, derPositiveInteger(Buffer.from([0x02]))), // v3 = 2
    derPositiveInteger(serial),
    derAlgSha256WithRsa(),
    nameDer,
    derSeq(derTime(now), derTime(notAfter)),
    nameDer,
    spkiDer,
    derExplicit(3, derSeq(...exts)),
  );

  return {
    cert: signX509Tbs(tbsDer, keys.privateKey),
    key: keys.keyPem,
  };
}

interface LoadedCaState {
  x509: X509Certificate;
  key: KeyObject;
  certPem: string;
  keyPem: string;
  serialBytes: Buffer;
  issuerDer: Buffer;
  subjectDer: Buffer;
  skiBytes: Buffer;
  extensions: Map<string, Buffer>;
}

function parseLoadedCa(certPem: string, keyPem: string): LoadedCaState {
  const x509 = new X509Certificate(certPem);
  const key = createPrivateKey(keyPem);
  const parsed = parseCaDer(x509.raw);
  const skiBytes = computeSubjectKeyIdentifier(x509.publicKey);
  return {
    x509,
    key,
    certPem,
    keyPem,
    serialBytes: parsed.serialBytes,
    issuerDer: parsed.issuerDer,
    subjectDer: parsed.subjectDer,
    skiBytes,
    extensions: parsed.extensions,
  };
}

/** Issue an in-memory leaf certificate for `hostname` signed by `ca`. */
export function issueInMemoryHostCert(
  hostname: string,
  ca: TLSCredentials,
  crlUrl?: string,
  sharedKeys?: KeyPairState,
): TLSCredentials {
  const caState = parseLoadedCa(ca.cert, ca.key);
  return issueHostCertFromLoadedCa(hostname, caState, crlUrl, sharedKeys ?? generateRsa2048());
}

function issueHostCertFromLoadedCa(
  hostname: string,
  ca: LoadedCaState,
  crlUrl: string | undefined,
  keys: KeyPairState,
): TLSCredentials {
  const serial = randomPositiveSerial(8);
  const now = new Date();
  const notAfter = new Date(now.getTime());
  notAfter.setFullYear(notAfter.getFullYear() + 1);

  const subjectDer = derName([{ oid: '2.5.4.3', value: hostname }]);
  const spkiDer = keys.publicKey.export({ type: 'spki', format: 'der' });

  // Bind this leaf to the CA's key id + serial so a client can distinguish a
  // leaf signed by the current CA from one signed by a rotated-out predecessor.
  const akiValue = derSeq(
    derImplicit(0, ca.skiBytes, false),
    derImplicit(1, derExplicit(4, ca.issuerDer), true),
    derImplicit(2, ca.serialBytes, false),
  );

  // subjectAltName: dNSName [2] IA5String
  const sanValue = derSeq(derImplicit(2, Buffer.from(hostname, 'ascii'), false));

  const exts: Buffer[] = [
    // basicConstraints: cA=FALSE (empty SEQUENCE per DER default)
    derExtension('2.5.29.19', true, derSeq()),
    // keyUsage: digitalSignature (bit 0) | keyEncipherment (bit 2) => 0xa0, 5 unused bits
    derExtension('2.5.29.15', true, derBitString(Buffer.from([0xa0]), 5)),
    // extKeyUsage: id-kp-serverAuth (1.3.6.1.5.5.7.3.1)
    derExtension('2.5.29.37', false, derSeq(derOid('1.3.6.1.5.5.7.3.1'))),
    derExtension('2.5.29.17', false, sanValue),
    derExtension('2.5.29.35', false, akiValue),
  ];
  if (crlUrl) {
    exts.push(derExtension('2.5.29.31', false, cdpSequence(crlUrl)));
  }

  const tbsDer = derSeq(
    derExplicit(0, derPositiveInteger(Buffer.from([0x02]))),
    derPositiveInteger(serial),
    derAlgSha256WithRsa(),
    ca.subjectDer,
    derSeq(derTime(now), derTime(notAfter)),
    subjectDer,
    spkiDer,
    derExplicit(3, derSeq(...exts)),
  );

  return {
    cert: signX509Tbs(tbsDer, ca.key),
    key: keys.keyPem,
  };
}

export class CertFactory {
  private caState: LoadedCaState | null = null;
  private certCache = new Map<string, TLSCredentials>();
  // Single shared key pair for all host certs — generated once, reused forever.
  private hostKeyPair: KeyPairState | null = null;

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
      this.hostKeyPair = generateRsa2048();
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
      const ca = this.caState!;
      const cdp = ca.extensions.get('2.5.29.31');
      const usable = ca.x509.checkPrivateKey(ca.key)
        && ca.x509.validToDate.getTime() > Date.now()
        && cdp !== undefined
        && cdp.equals(cdpSequence(this.crlUrl));
      if (usable) return 'reused';
    } catch { /* missing or unreadable: make a new one */ }
    this.caState = null;
    this.generateCA();
    return 'generated';
  }

  generateCA(): TLSCredentials {
    const dir = getLlmFwDir();
    fs.mkdirSync(dir, { recursive: true });
    restrictDirPermissions(dir);

    const creds = issueInMemoryCA('llm-fw Local CA', this.crlUrl);

    fs.writeFileSync(caCertPath(), creds.cert, { encoding: 'utf8' });
    fs.writeFileSync(caKeyPath(), creds.key, { encoding: 'utf8' });

    this.caState = parseLoadedCa(creds.cert, creds.key);
    this.warmHostKey();

    return creds;
  }

  loadCA(): TLSCredentials {
    const certPem = fs.readFileSync(caCertPath(), 'utf8');
    const keyPem = fs.readFileSync(caKeyPath(), 'utf8');

    this.caState = parseLoadedCa(certPem, keyPem);

    return { cert: certPem, key: keyPem };
  }

  private getOrLoadCA(): LoadedCaState {
    if (this.caState) return this.caState;

    if (fs.existsSync(caCertPath())) {
      this.loadCA();
      return this.caState!;
    }

    throw new Error('CA not found. Run: llm-fw setup');
  }

  // Generate an empty CRL signed by the CA and write it to ~/.llm-fw/ca.crl.
  // Schannel (Windows) checks the CRL Distribution Point in every cert; without
  // a reachable CRL it reports "revocation status unknown" and rejects the cert.
  generateAndSaveCRL(): void {
    const ca = this.getOrLoadCA();

    const now = new Date();
    const nextUpdate = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
    const algId = derAlgSha256WithRsa();

    // TBSCertList (no revokedCertificates → empty CRL), reusing the CA's exact
    // issuer Name DER bytes so byte-level name matching always succeeds.
    const tbsCertList = derSeq(
      algId,
      ca.issuerDer,
      derTime(now),
      derTime(nextUpdate),
    );

    const sigBytes = cryptoSign('sha256', tbsCertList, ca.key);
    const crlDer = derSeq(
      tbsCertList,
      algId,
      derBitString(sigBytes, 0),
    );

    fs.writeFileSync(crlPath(), crlDer);
  }

  getHostCert(hostname: string): TLSCredentials {
    const cached = this.certCache.get(hostname);
    if (cached) return cached;

    const ca = this.getOrLoadCA();
    this.warmHostKey();
    const credentials = issueHostCertFromLoadedCa(hostname, ca, this.crlUrl, this.hostKeyPair!);
    this.certCache.set(hostname, credentials);

    return credentials;
  }
}
