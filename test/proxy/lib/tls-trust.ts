import tls from 'node:tls'
import { issueInMemoryCA, issueInMemoryHostCert } from '../../../src/proxy/certs.js'

/**
 * TLS helpers shared by the proxy E2E suites.
 *
 * These suites used to open with `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`,
 * which switches certificate verification off for every socket in the worker —
 * including the ones the test is asserting on. Two things came of that: CodeQL
 * flagged it (js/disabling-certificate-validation), and, worse, the suites could
 * not have noticed the proxy serving a chain no real client would accept. The
 * mock upstream's certificate had no subjectAltName at all and the tests still
 * passed.
 *
 * Instead: generate a real CA for the mock upstream, add it to the process trust
 * store for the lifetime of the file, and leave verification on everywhere.
 */

/** A CA plus a server certificate issued by it, all PEM. */
export interface UpstreamCert {
  /** PEM of the CA — feed to `trustCA` so the proxy's outbound leg accepts it. */
  ca: string
  /** Server key, for `https.createServer`. */
  key: string
  /** Server certificate chain (leaf then CA), for `https.createServer`. */
  cert: string
}

/**
 * Issue a server certificate for `host` from a throwaway CA.
 *
 * The leaf carries a subjectAltName, which is what Node actually checks —
 * commonName alone has not been accepted since Node 18, and the old fixtures
 * only got away with it because verification was off.
 */
export function issueUpstreamCert(host = 'api.anthropic.com'): UpstreamCert {
  const ca = issueInMemoryCA('llm-fw test upstream CA')
  const leaf = issueInMemoryHostCert(host, ca)
  return { ca: ca.cert, key: leaf.key, cert: leaf.cert + ca.cert }
}

/**
 * Add `caPem` to the process-wide default trust store and return an undo.
 *
 * Process-wide is the requirement, not a convenience: the connection that has to
 * accept the mock upstream is the one ProxyServer opens itself (`tls.connect` in
 * forwardRequest), so there is no options object the test can reach. Call the
 * returned function in `afterAll` — vitest reuses a worker across files, and a
 * leaked trust anchor would silently widen the next suite.
 */
export function trustCA(caPem: string): () => void {
  const previous = tls.getCACertificates('default')
  tls.setDefaultCACertificates([...previous, caPem])
  return () => { tls.setDefaultCACertificates(previous) }
}
