// The container's health probe (#870). /readyz answers 503 until the
// embedding model is loaded, so traffic is never routed to an instance that
// cannot scan yet. With gateway TLS on (LLM_FW_GATEWAY_TLS_CERT and _KEY) the
// gateway serves HTTPS on the same port, and the probe follows it: the inline
// probe this replaces always spoke plain HTTP, so such a container never
// reported healthy.
//
// The probe trusts exactly the configured certificate file (its leaf, or any
// certificate in the chain it holds) and nothing else. It does not check the
// host name, since it dials 127.0.0.1 and the certificate names the public
// host; a certificate that does not chain to the file is still refused.
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'

const port = Number(process.env.LLM_FW_GATEWAY_PORT || 8081)
const certFile = process.env.LLM_FW_GATEWAY_TLS_CERT
const tls = Boolean(certFile && process.env.LLM_FW_GATEWAY_TLS_KEY)

const options = { host: '127.0.0.1', port, path: '/readyz', timeout: 4000 }
const req = tls
  ? https.get({ ...options, ca: fs.readFileSync(certFile, 'utf8'), allowPartialTrustChain: true, checkServerIdentity: () => undefined }, done)
  : http.get(options, done)
req.on('timeout', () => req.destroy(new Error('timed out')))
req.on('error', () => process.exit(1))

function done(res) {
  res.resume()
  process.exit(res.statusCode === 200 ? 0 : 1)
}
