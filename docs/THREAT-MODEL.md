[llm-fw](../README.md) > [Documentation](README.md) > Threat model

# Threat model

What llm-fw protects, from whom, and where each trust boundary sits. Each
mitigation names the code that enforces it, so a reader can check the claim
instead of trusting it. What llm-fw does when it cannot inspect something is
in the [failure semantics table](guides/configuration.md#every-path-open-or-closed);
what a version promises not to change is in [STABILITY.md](STABILITY.md).

## What llm-fw is for, and what it is not

llm-fw sits between an LLM client (an agent, an IDE, an SDK) and the
provider, and refuses requests that carry a prompt injection or leak a
secret. It is a filter on traffic its operator already trusts to reach the
provider. It is not a sandbox for the agent, it does not decide what tools
an agent may run, and a determined attacker who controls the client process
itself can always bypass it (for example by not using the proxy). Detection
is probabilistic: the measured precision, recall and false-positive rate are
in [SCORECARD.md](SCORECARD.md) and [FALSE-POSITIVES.md](FALSE-POSITIVES.md).

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| The CA private key | `<LLM_FW_DIR>/ca.key` | Installed in the OS trust store; whoever reads it can intercept every TLS connection the machine makes |
| Provider API keys | the client's headers, or `LLM_FW_GATEWAY_KEY_<SLUG>` under gateway key custody | Spend on the operator's account; custody keeps them away from clients |
| Gateway, proxy and dashboard tokens | config, environment, generated at start when a non-loopback bind needs one | Authorize use of the firewall and of the dashboard API |
| Prompts and tool output | in flight; the matched text of each event in the dashboard's in-memory event log; whole payloads in `audit.jsonl` and the audit webhook only when `audit.includePayloads` is on | Source code, documents and secrets pass through |
| The verdict itself | the pipeline's result for each request | A wrong pass forwards an injection; a wrong block breaks a working agent |
| Licence keys | `<LLM_FW_DIR>` | Informational only: no feature is gated on them |

## Attackers

| Attacker | Can do | Cannot do, by assumption |
| --- | --- | --- |
| **Malicious content**: a web page, a document, a repository file, an MCP server's reply, a tool's output | Put text in front of the model, through any field the provider reads | Run code on the host, or reach the firewall's listeners |
| **A malicious web page in the user's browser** | Make the browser send requests to `127.0.0.1` ports, including after DNS rebinding | Read responses across origins, or send `CONNECT` |
| **A remote network client** | Connect to a listener that is bound beyond loopback | Present a token it was not given |
| **A malicious repository in the working directory** | Plant files that a tool started there might read | Change the firewall's configuration (since 0.9.0) |
| **A hostile upstream response** | Return text, URLs or images that try to exfiltrate data | Change what the request side already decided |
| **Another local account on the same machine** | Read files its ACLs allow | Read the user's `LLM_FW_DIR` |
| **A gateway tenant** | Send any request its token allows, to the providers its tenant allows | Exceed its quota, use another tenant's identity, or read the dashboard |

Out of scope: an attacker running as the same user as llm-fw (it can read
the CA key, change the config and stop the process), a compromised provider,
and a compromised build of llm-fw or its dependencies (see the
[SBOM and provenance](PUBLISHING.md)).

## Trust boundaries, one per listener

Every listener binds `127.0.0.1` by default. Bound anywhere else, it requires
a token, and generates one if none is configured (`resolveAuthPolicy`,
`src/auth.ts`). An explicit `requireAuth: false` on a wildcard bind is the one
way to build an open relay, and is the operator's decision.

### Forward proxy (`proxy.port`, default 8080)

- **Who reaches it:** local processes; remote clients when bound beyond
  loopback, with the proxy token.
- **What crosses it:** `CONNECT` only. Intercepted hosts (the provider list in
  `src/config/providers.ts`) are TLS-terminated with a leaf certificate from
  the local CA and scanned; every other host is tunnelled untouched. Plain HTTP
  gets `501`.
- **Enforced by:** the auth check runs first in `handleConnect`, before the
  bypass tunnel (`test/proxy/proxy-auth.e2e.test.ts`). A non-loopback client
  cannot tunnel into the host's own loopback or link-local addresses, checked
  on the address actually connected to (`src/proxy/tunnelGuard.ts`).

### Gateway (`gateway.port`, default 8081, opt-in)

- **Who reaches it:** SDKs that set `base_url` to it; tenants with their own
  tokens.
- **What crosses it:** provider-shaped requests, routed by path to a fixed or
  operator-configured host (`src/gateway/routes.ts`), so a caller chooses the
  path and never the host.
- **Enforced by:** auth, then the tenant's provider allowlist, then quota,
  then the scan (`src/gateway/gateway.ts`). Key custody replaces every client
  credential header and strips credential query parameters. Loopback trust
  needs a loopback `Host` header, so a rebound browser page is not loopback
  (`isLoopbackHostHeader`, `src/auth.ts`). Response-side scanning is
  proxy-only.

### Dashboard (`dashboard.port`, default 7731)

- **Who reaches it:** the operator's browser.
- **What crosses it:** the UI, the HTTP API, SSE, `/metrics`, `/ca.crt` and
  `/crl`.
- **Enforced by:** loopback is exempt from the token only with a loopback
  `Host`; state-changing routes need a JSON content type and a same-origin
  request; the page carries `Content-Security-Policy: default-src 'none'`
  with `frame-ancestors 'none'` (`test/dashboard/csp.spec.ts`). `/ca.crt` and
  `/crl` are public by design: a client cannot present a token before it
  trusts the CA.

### Sinkhole (`proxy.httpsPort`, default 8443, loopback only)

Hosts-file mode: the provider hostnames resolve to `127.0.0.1` and their TLS
lands here. Hardwired to loopback; same scanning as the proxy.

## The detection boundary

The request side decides. Everything the provider will read must be read
first, so the boundary is the set of fields llm-fw extracts:

- **Bodies must parse exactly.** A body that is not valid JSON, or repeats a
  key, is refused with stage `malformed-body`, since a provider might read
  what `JSON.parse` did not (`src/detection/jsonStrict.ts`).
- **Paths are matched canonically.** `/v1//messages` and `/v1/%6Dessages` are
  the Messages API (`src/detection/canonicalPath.ts`).
- **Compressed bodies are decoded first**, and refused when undecodable
  (`src/proxy/contentEncoding.ts`).
- **Third-party text is scanned wherever it arrives:** `tool_result`,
  server-tool and hosted-tool results, search results, grounding documents,
  MCP replies (`src/detection/parsers.ts`, with
  `test/detection/parsers-third-party-text.test.ts`).
- **The cost of a scan is bounded** per text and per request
  (`detection.embeddingMaxChunks`, `detection.embeddingMaxPassesPerRequest`),
  every regex runs in linear time (`.claude/rules/detection.md`), and a scan
  hands the event loop back between steps so one large request does not
  hold the others for all of it (one heuristic pass over one whole text
  still cannot pause; see accepted risks).

Surfaces carry different trust. The system prompt and tool definitions are
developer-authored: the system prompt is not scanned unless
`detection.scanSystemPrompt` is on (agent memory spliced into it still is),
and tool definitions skip the embedding check. Tool output, documents and
memory are third-party. Every scanned surface blocks by default. Two opt-ins trade
recall for fewer false positives: `detection.surfaces.prompt.wordingAction:
"warn"` warns on a wording-only match in the user's own prompt below a
high-confidence tier, and `trustedPaths` downgrade plain file reads under a
named root to warn.

## Host and files

- `LLM_FW_DIR` (default `~/.llm-fw`) holds the CA key, config, suppressions,
  the audit log and the licence. It is locked to the user: `0700` and
  `ca.key` `0600` on POSIX, an icacls ACL naming `DOMAIN\user` and SYSTEM on
  Windows (`restrictDirPermissions`, `src/proxy/certs.ts`).
- Configuration comes from defaults, `<LLM_FW_DIR>/config.json`, a JSON file
  named by `LLM_FW_CONFIG`, and `LLM_FW_*` variables. Never from the working
  directory (`src/config/config.ts`).
- Error logs print request paths and parameter names, never query values
  (`urlForLog`, `src/logger.ts`); the audit webhook and file sink both drop
  payloads unless `audit.includePayloads` is on.

## Accepted risks

Each is a decision, with the reason, rather than an oversight:

- **A very large request still delays others.** A scan hands the event
  loop back between steps, but one heuristic pass over one whole text cannot
  pause, about 0.4 s per MB: a 10 MiB text holds other requests for several
  seconds (measured 3.1 s worst case for 2.5 MB through the gateway). An
  attacker needs a token on any non-loopback bind, and `dos` rate limits
  apply. Worker-thread scanning and a per-request text cap were considered
  and not taken (#464).

- **Response-side inspection fails open** on a response too large or
  undecodable to read: it is defence in depth behind the request side.
- **A spent embedding budget warns rather than refuses**: the heuristic stage
  still read every byte, and refusing would break a long session resumed
  after a restart.
- **The judge is never fatal**: an unreachable Ollama returns `ERROR` and the
  scan continues without it.
- **Quotas, crescendo state and the verdict caches are per process**, so they
  do not aggregate across replicas.
- **An upstream error body reaches the client unchanged**, so OpenAI's
  "Incorrect API key provided: sk-...abcd" shows the last four characters of
  an operator key under custody.
- **The licence can be made to report licensed** by overriding its verify key
  in the environment; it gates nothing.

## Reporting

Vulnerabilities go to the private channel in [SECURITY.md](../SECURITY.md),
not to a public issue.
