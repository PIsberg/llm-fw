# Rule: proxy, gateway and auth

Read when touching `src/proxy/`, `src/gateway/`, `src/auth.ts`, or anything
that binds a port.

## The surfaces

| Surface | Default port | Default bind | Started by |
| --- | --- | --- | --- |
| Forward proxy (CONNECT only) | 8080 | `127.0.0.1` | always, on `llm-fw start` |
| Dashboard, HTTP API, `/metrics`, `/ca.crt`, `/crl` | 7731 | `127.0.0.1` | always |
| Gateway | 8081 | `127.0.0.1` | `--gateway` or `LLM_FW_GATEWAY_ENABLED` |
| Sinkhole TLS | 8443 | `127.0.0.1`, hardwired | `proxy.mode === 'sinkhole'` or a hosts-file marker |

`src/cli/start.ts` wires all of them. Flags are applied gateway, then observe,
then standalone.

## Auth is inferred from the bind address

`resolveAuthPolicy` in `src/auth.ts`: bound to loopback, no token required;
bound anywhere else, a token is required and generated if not configured. An
explicit `requireAuth: false` disables it even on a wildcard bind, which is the
one way to produce an open relay.

Rules that must not regress:

- The proxy's auth check runs **first** in `handleConnect`, before the bypass
  tunnel and regardless of `LLM_FW_BYPASS`. Pinned by
  `test/proxy/proxy-auth.e2e.test.ts`.
- Token comparison hashes both sides and uses a constant-time compare. Do not
  replace it with `===`.
- `/ca.crt`, `/ca.pem` and `/crl` stay unauthenticated. A client cannot present
  a token before it trusts the CA.
- `/healthz`, `/livez` and `/readyz` answer before auth. A kubelet cannot
  present a token.
- State-changing dashboard routes keep the JSON content-type plus same-origin
  check.

## Asymmetries to preserve, or fix deliberately

These are real and load-bearing. If you change one, it is a behaviour change
that needs a changelog entry, not a cleanup.

- **Response-side scanning is proxy-only.** The gateway runs the request-side
  pipeline and streams responses through untouched.
- **Health endpoints exist only on the gateway.** Nothing answers on the proxy
  or the dashboard.
- **The dashboard exempts loopback unconditionally** and has no `requireAuth`.
- **The proxy has no `request` handler**, only `connect`. Plain proxied HTTP
  hangs. Documented as a limitation in
  [docs/guides/deployment-server.md](../../docs/guides/deployment-server.md).
- **`NO_PROXY` is not implemented** anywhere in the product.
- **The CRL distribution point is hardcoded** to `http://127.0.0.1:7731/crl` in
  `src/proxy/certs.ts`, in the CA and in every leaf, ignoring `dashboard.port`.
- **Quotas and crescendo state are per-process**, so they do not aggregate
  across replicas.

## Certificates

`src/proxy/certs.ts` owns the CA at `<LLM_FW_DIR>/ca.crt` and `ca.key`, with the
directory locked to the running user. Losing `ca.key` means every client must
re-trust a new CA. Leaf certs share one pre-generated key pair on purpose, to
keep RSA generation off the event loop.
