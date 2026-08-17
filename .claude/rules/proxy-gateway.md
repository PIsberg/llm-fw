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
- **The proxy forwards CONNECT only.** Its `request` handler exists solely to
  answer `501` with an explanation, so a client that set `HTTP_PROXY` fails fast
  instead of hanging. Do not grow it into a plain-HTTP forward path without
  deciding what that means for the URL filter and for open-relay exposure.
  Pinned by `test/proxy/proxy-plain-http.e2e.test.ts`.
- **`NO_PROXY` is a client-side variable.** Nothing in llm-fw reads it and
  nothing should: it instructs the caller's HTTP stack. The only lever here is
  the default `setup` persists (`DEFAULT_NO_PROXY` in `src/cli/setup.ts`).
- **The CRL distribution point follows `dashboard.bindHost`/`port`** via
  `crlUrlFor` in `src/proxy/certs.ts`. Keep it reachable by the *client*: a
  wildcard bind resolves to the LAN address, never `0.0.0.0`, and never assume
  loopback. Pinned by `test/proxy/certs-crl.test.ts`.
- **Quotas and crescendo state are per-process**, so they do not aggregate
  across replicas.

## Certificates

`src/proxy/certs.ts` owns the CA at `<LLM_FW_DIR>/ca.crt` and `ca.key`, with the
directory locked to the running user. Losing `ca.key` means every client must
re-trust a new CA. Leaf certs share one pre-generated key pair on purpose, to
keep RSA generation off the event loop.
