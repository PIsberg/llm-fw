[llm-fw](../../README.md) > [Documentation](../README.md) > Server deployment

# Running llm-fw on a server

How to run one firewall for many clients: which mode to pick, how to start it
under systemd, Docker or Kubernetes, what to pin before anyone connects, and
what to check when it misbehaves.

The companion guide is [Client setup](client-setup.md), which covers the other
end of the connection.

## Table of contents

- [Pick a mode first](#pick-a-mode-first)
- [Host requirements](#host-requirements)
- [Install](#install)
- [Pin your tokens before you bind](#pin-your-tokens-before-you-bind)
- [Standalone forward-proxy server](#standalone-forward-proxy-server)
- [Gateway server](#gateway-server)
- [Run it under systemd](#run-it-under-systemd)
- [Docker](#docker)
- [Kubernetes](#kubernetes)
- [Ports and firewall rules](#ports-and-firewall-rules)
- [Authentication reference](#authentication-reference)
- [Persistence and backup](#persistence-and-backup)
- [Audit log and SIEM export](#audit-log-and-siem-export)
- [Health checks and monitoring](#health-checks-and-monitoring)
- [The judge (Ollama), optional](#the-judge-ollama-optional)
- [Upgrades](#upgrades)
- [Hardening checklist](#hardening-checklist)
- [Limitations to know before you commit](#limitations-to-know-before-you-commit)
- [Troubleshooting](#troubleshooting)

---

## Pick a mode first

Everything downstream depends on this choice.

| | Forward proxy (`--standalone`) | Gateway (`--gateway`) |
| --- | --- | --- |
| What the client changes | `HTTPS_PROXY` plus a trusted CA | its SDK `base_url` |
| CA distribution | required on every client | none |
| Works in CI, containers, serverless | no | yes |
| Provider API keys held server-side | no | yes |
| Request-side detection | yes | yes |
| Response-side detection (exfiltration, harmful compliance, tool-use args) | yes | no, responses stream through unscanned |
| Covers non-LLM traffic (URL filter, host taint) | yes | no |
| Per-tenant tokens and quotas | no | yes |

Response-side scanning running on the proxy only is a real gap, not a
simplification: the gateway forwards upstream bytes through untouched. If
exfiltration filtering matters to you, the forward proxy is the mode that has it.

Both listeners can run in the same process. `llm-fw start --standalone --gateway`
is a valid and common combination: proxy-capable clients get full coverage,
everything else uses `base_url`.

---

## Host requirements

- **Node.js 22 or newer.** Enforced by `engines` in `package.json`.
- **Memory.** The Helm chart requests 1Gi and limits 2Gi, which is a sound
  starting point. `llm-fw start` loads the always-on embedding model **eagerly,
  before any listener binds**, and then keeps it resident, so the process takes
  several seconds to become reachable on a cold start.
- **Disk.** A few hundred MB for the model cache, plus whatever you allow the
  audit log to grow to (64 MiB per generation, one generation kept, by default).
- **CPU.** Detection is CPU-bound. Scanning is the work; forwarding is not.
- **No root needed** for proxy or gateway mode. Root or Administrator is only
  needed for the sinkhole and for installing the CA into a machine trust store,
  and the sinkhole is disabled in standalone mode anyway.

---

## Install

```bash
npm install -g llm-fw
llm-fw setup --proxy-only
```

`setup` generates the CA at `~/.llm-fw/ca.crt` and `~/.llm-fw/ca.key`, locks the
directory down to the running user (`chmod 0700`, or the `icacls` equivalent on
Windows), and writes `~/.llm-fw/config.json`.

Use `--proxy-only` on a server. Plain `llm-fw setup` also tries to install the
sinkhole, which rewrites the hosts file and adds an OS-level `443` redirect. On
a shared server that is both useless (it only ever affects traffic originating
on the server itself) and disruptive.

Gateway-only deployments do not need the CA at all, but `setup` is still the
cheapest way to get a config file in place.

---

## Pin your tokens before you bind

This is the step that most often gets skipped and always hurts later.

Every listener infers its authentication requirement from its bind address
(`resolveAuthPolicy` in `src/auth.ts`): bound to loopback, no token is required;
bound anywhere else, a token becomes mandatory. If you have not configured one,
llm-fw generates a 48-character token **per process** and prints it at startup.

That generated token changes on every restart. Every client breaks on every
restart, every deploy, every crash-loop. Pin all three:

```bash
export LLM_FW_PROXY_TOKEN=$(openssl rand -hex 24)
export LLM_FW_GATEWAY_TOKEN=$(openssl rand -hex 24)
export LLM_FW_DASHBOARD_TOKEN=$(openssl rand -hex 24)
```

Use three different values. They protect different things: the proxy token
authorises traffic relay, the gateway token authorises API calls (and may be
standing in front of your provider billing), and the dashboard token grants read
access to captured prompt payloads plus write access to the defense toggles.

> **Boolean environment variables are strictly the string `true`.** Config
> parsing tests `v === 'true'`, so `LLM_FW_JUDGE_ENABLED=1` and
> `LLM_FW_JUDGE_ENABLED=yes` both evaluate to **false**. An empty string is
> ignored entirely rather than treated as false.

---

## Standalone forward-proxy server

```bash
llm-fw setup --proxy-only
LLM_FW_PROXY_TOKEN=... LLM_FW_DASHBOARD_TOKEN=... llm-fw start --standalone
```

`--standalone` (alias `--stand-alone`) does three things: forces
`proxy.mode` to `proxy`, binds the proxy and dashboard to `0.0.0.0`, and disables
the sinkhole. An explicit `LLM_FW_PROXY_BIND` or `LLM_FW_DASHBOARD_BIND` wins
over the wildcard, which is how you expose the proxy while keeping the dashboard
on loopback:

```bash
LLM_FW_DASHBOARD_BIND=127.0.0.1 llm-fw start --standalone
```

On start it prints the client setup commands with the server's LAN IP and the
proxy credential already inlined. Use what it prints.

### What clients need

The credential is not optional. An unauthenticated `CONNECT` is rejected with
`407 Proxy Authentication Required` before anything else happens, including
before the bypass tunnel and regardless of `LLM_FW_BYPASS`. The client-side form
carries the token in the proxy URL:

```bash
export HTTPS_PROXY=http://llm-fw:TOKEN@192.168.1.50:8080
```

Clients also need the CA. It is served unauthenticated on the dashboard port,
precisely so a client can bootstrap trust before it has a token:

```bash
curl -o llm-fw-ca.crt http://192.168.1.50:7731/ca.crt?download
```

Full per-OS and per-runtime instructions are in
[Client setup](client-setup.md#install-the-ca).

### Bind and token defaults

| Setting | Default | Under `--standalone` | Override |
| --- | --- | --- | --- |
| Proxy bind | `127.0.0.1` | `0.0.0.0` | `LLM_FW_PROXY_BIND` |
| Proxy token | not required | required, generated if unset | `LLM_FW_PROXY_TOKEN` |
| Dashboard bind | `127.0.0.1` | `0.0.0.0` | `LLM_FW_DASHBOARD_BIND` |
| Dashboard token | not required | required, generated if unset | `LLM_FW_DASHBOARD_TOKEN` |
| Gateway bind | `127.0.0.1` | `0.0.0.0` only if the gateway is enabled | `LLM_FW_GATEWAY_BIND` |
| Gateway token | not required | required, generated if unset | `LLM_FW_GATEWAY_TOKEN` |

Setting `proxy.requireAuth: false` (or `LLM_FW_PROXY_REQUIRE_AUTH=false`)
disables the check even on a wildcard bind. That is the one configuration that
produces an open relay reachable by any host that can route to the port. It
warns loudly at startup and nothing stops you. Do not do it.

### What actually gets intercepted

The proxy does not decrypt everything it carries. A host is intercepted only if
it matches `targets` (the built-in AI-provider host list) or
`proxy.interceptDomains` (`openai.azure.com` and `aiplatform.googleapis.com` by
default). Everything else is tunneled through without inspection.

Two knobs control this fleet-wide, and both are worth knowing before you point a
hundred machines at the box:

- `LLM_FW_EXTRA_TARGETS` — comma-separated, **appends** to the provider list.
- `LLM_FW_INTERCEPT_DOMAINS` — comma-separated, **replaces** the suffix list.

Overriding `targets` in a config file replaces the entire built-in registry
rather than adding to it. Use `extraTargets` instead.

Tunneled traffic is uninspected but not ungated: a CONNECT can still be refused
by the host taint check or the URL filter before the tunnel opens. See
[Limitations](#limitations-to-know-before-you-commit).

---

## Gateway server

```bash
LLM_FW_GATEWAY_TOKEN=... LLM_FW_GATEWAY_BIND=0.0.0.0 llm-fw start --gateway
```

**`--gateway` on its own binds to `127.0.0.1` and no remote client can reach
it.** Either add `--standalone` or set `LLM_FW_GATEWAY_BIND=0.0.0.0`. The Docker
image and the Helm chart both set that variable, which is why they work out of
the box.

The gateway listens on **8081** and serves **plain HTTP** by default. Clients
using `https://` need TLS terminated somewhere: an ingress or load balancer in
front (the usual arrangement), or served directly with
`LLM_FW_GATEWAY_TLS_CERT` and `LLM_FW_GATEWAY_TLS_KEY` pointing at PEM files.

Provider key custody is the gateway's main operational advantage. Set
`LLM_FW_GATEWAY_KEY_<SLUG>` and the gateway strips whatever credential the
client sent, along with every other credential header, and substitutes yours:

```bash
export LLM_FW_GATEWAY_KEY_ANTHROPIC=sk-ant-...
export LLM_FW_GATEWAY_KEY_OPENAI=sk-...
```

The slug is the environment-variable suffix, lowercased. Custody is opt-in per
provider: with no key configured for a slug, the client's own credential passes
through untouched.

Routing, tenants, quotas and the full provider list are in
[Gateway mode](gateway-mode.md).

---

## Run it under systemd

`llm-fw install-service` exists, but it registers the invocation as a bare
`node <script> start` with **no flags**, and it ignores any arguments you pass
it. It is built for a single-user desktop. On a server, write the unit yourself
so that mode and tokens are explicit.

`/etc/systemd/system/llm-fw.service`:

```ini
[Unit]
Description=llm-fw prompt injection firewall
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=llmfw
Group=llmfw
Environment=LLM_FW_DIR=/var/lib/llm-fw
EnvironmentFile=/etc/llm-fw/llm-fw.env
ExecStart=/usr/bin/llm-fw start --standalone --gateway
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/llm-fw
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
```

`/etc/llm-fw/llm-fw.env`, mode `0600`, owned by root:

```
LLM_FW_PROXY_TOKEN=...
LLM_FW_GATEWAY_TOKEN=...
LLM_FW_DASHBOARD_TOKEN=...
LLM_FW_DASHBOARD_BIND=127.0.0.1
LLM_FW_GATEWAY_BIND=0.0.0.0
LLM_FW_GATEWAY_KEY_ANTHROPIC=sk-ant-...
LLM_FW_AUDIT_ENABLED=true
```

Then:

```bash
sudo useradd --system --home /var/lib/llm-fw --shell /usr/sbin/nologin llmfw
sudo install -d -o llmfw -g llmfw -m 0700 /var/lib/llm-fw
sudo -u llmfw LLM_FW_DIR=/var/lib/llm-fw llm-fw setup --proxy-only
sudo systemctl daemon-reload
sudo systemctl enable --now llm-fw
```

Run `setup` as the service user with the same `LLM_FW_DIR`. The CA private key
is written into a directory locked to whoever runs it, and a CA the service
account cannot read is the most common first-boot failure.

`LLM_FW_DIR` is resolved when the certificate module is first imported, so it
has to be present in the process environment. Setting it later, from a config
file, has no effect on where the CA is looked for.

---

## Docker

The image bakes the embedding model in at build time, so the first request after
a rollout is not a 30 MB download and the container works on an air-gapped
network.

The image already sets `LLM_FW_GATEWAY_ENABLED=true` and binds all three
listeners to `0.0.0.0`, which means all three demand a token. It exposes `8081`,
`8080` and `7731`, runs as the unprivileged `node` user, and its `CMD` is
`start --gateway`.

```bash
docker compose up -d
```

Put the secrets in a `.env` file next to `docker-compose.yml` first:

```
LLM_FW_GATEWAY_TOKEN=<long random string clients present>
LLM_FW_DASHBOARD_TOKEN=<a different one>
LLM_FW_PROXY_TOKEN=<a third one>
LLM_FW_GATEWAY_KEY_ANTHROPIC=sk-ant-...
LLM_FW_GATEWAY_KEY_OPENAI=sk-...
```

The compose file publishes the gateway and proxy on all interfaces but binds the
dashboard to `127.0.0.1:7731` on the host, so reaching it means an SSH tunnel
rather than an open port. Keep it that way.

**Mount `/data`.** That is `LLM_FW_DIR` in the image, and it holds the CA key,
the suppression list, the licence and the audit log. The compose file uses a
named volume `llm-fw-data` for exactly this. Do **not** mount over `/models`,
which is the baked-in read-only model cache.

The image ships a `HEALTHCHECK` that polls `/readyz` on the gateway port.

---

## Kubernetes

A chart lives at `deploy/helm/llm-fw`.

```bash
helm install llm-fw deploy/helm/llm-fw --set secrets.gatewayToken=TOKEN --set secrets.dashboardToken=OTHER --set secrets.providerKeys.anthropic=sk-ant-...
```

What the chart does for you: `startupProbe` and `readinessProbe` on `/readyz` so
a pod still loading its model is never sent traffic, `livenessProbe` on
`/healthz`, a PVC mounted at `/data` for the CA key, suppression list and audit
log, `runAsNonRoot` with all capabilities dropped, and a `checksum/secret` pod
annotation so rotating a token rolls the pods.

Four things to set deliberately:

1. **`secrets.gatewayToken`.** Without one, every pod generates its own at
   startup and every rollout invalidates your clients' token.
2. **`image.tag`.** `Chart.yaml` carries `appVersion: 0.4.1` while the package is
   at `0.5.0`, so a default install pulls a stale tag. Pin it.
3. **Keep `gateway.enabled: true`** unless you are replacing the probes.
   `/healthz`, `/livez` and `/readyz` exist **only** on the gateway listener.
   Turn the gateway off and the kubelet has nothing to probe, and will
   crash-loop the pod.
4. **`replicaCount`.** Quotas, cross-request crescendo memory and per-tenant
   limits are per-process and in-memory. Three replicas with a 60/min tenant
   quota admit up to 180/min. The chart defaults to 1 for this reason, and to
   the `Recreate` strategy when persistence is on, because the claim is RWO.

The dashboard is deliberately **not** exposed through the ingress. It renders
captured request payloads. Reach it with `kubectl port-forward`.

---

## Ports and firewall rules

| Port | Listener | Default bind | Config key | Env override |
| --- | --- | --- | --- | --- |
| 8080 | Forward proxy (CONNECT) | `127.0.0.1` | `proxy.port` | `LLM_FW_PROXY_PORT` |
| 8081 | Gateway | `127.0.0.1` | `gateway.port` | `LLM_FW_GATEWAY_PORT` |
| 7731 | Dashboard, HTTP API, `/metrics`, `/ca.crt`, `/crl` | `127.0.0.1` | `dashboard.port` | `LLM_FW_DASHBOARD_PORT` |
| 8443 | Sinkhole TLS (loopback only, never remote) | `127.0.0.1` | `proxy.httpsPort` | `LLM_FW_HTTPS_PORT` |

There is no command-line flag for any port. Ports are config-file or environment
only, and they are **cold** settings: hot reload detects a change and logs
"restart required" without applying it.

A minimal ruleset for a proxy server:

```bash
# proxy, reachable from the client subnet only
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp
# dashboard stays off the network; reach it over SSH
ssh -L 7731:127.0.0.1:7731 user@server
```

> **Do not change `LLM_FW_DASHBOARD_PORT` on a forward-proxy server.** The CRL
> distribution point embedded in the CA and in every leaf certificate is
> hardcoded to `http://127.0.0.1:7731/crl`. Moving the dashboard port silently
> breaks revocation checking for certificates the firewall issues, which Windows
> clients in particular depend on.

---

## Authentication reference

| Surface | Env var | Header the client sends | Rejection |
| --- | --- | --- | --- |
| Forward proxy | `LLM_FW_PROXY_TOKEN` | `Proxy-Authorization: Basic` or `Bearer`, usually via `http://llm-fw:TOKEN@host:8080` | `407` |
| Gateway | `LLM_FW_GATEWAY_TOKEN` | `X-Llm-Fw-Key`, or `Authorization: Bearer` | `401` |
| Dashboard and HTTP API | `LLM_FW_DASHBOARD_TOKEN` | `Authorization: Bearer` or Basic (token as password), or `?token=` | `401` |

Shared behaviour worth knowing:

- Tokens are compared by hashing both sides and using a constant-time compare,
  so a wrong length does not leak through timing.
- **Loopback callers bypass the dashboard token unconditionally.** Anyone with a
  shell on the server, or any process on it, reads every captured payload and can
  toggle defenses. There is no `dashboard.requireAuth` to close this.
- `/ca.crt`, `/ca.pem` and `/crl` are always unauthenticated. A client cannot
  present a token before it trusts the CA.
- `/healthz`, `/livez` and `/readyz` answer before authentication, because a
  kubelet cannot present a token.
- State-changing dashboard requests additionally require
  `Content-Type: application/json` and a same-origin `Origin` or `Referer`.

---

## Persistence and backup

Everything lives under `LLM_FW_DIR` (`~/.llm-fw` by default, `/data` in the
image).

| File | Back it up? | Why |
| --- | --- | --- |
| `ca.key`, `ca.crt`, `ca.crl` | **Yes** | Losing the key means a new CA and re-trusting every client |
| `suppressions.json` | **Yes** | The list that downgrades known false positives; rebuilt only by hand |
| `whitelist.json` | Yes | Operator audit trail of marked false positives |
| `config.json` | Yes | Written by `setup`, `setup-judge`, and dashboard settings changes |
| `license.key`, `license-offline.lfw` | Yes | Your licence |
| `audit.jsonl`, `audit.jsonl.1` | Ship it, do not back it up | Rotating log; send it to a SIEM |
| `llm-fw.pid` | No | Recreated at start |
| `models/` | No | Re-downloadable cache |

`ca.key` is the sensitive one. Anyone holding it can mint a certificate that
every client in your fleet trusts. Treat it exactly as you would any private CA
key, because that is what it is.

---

## Audit log and SIEM export

Off by default. Without it, events live only in an in-memory ring of 100 and are
lost on restart, which answers no retention question.

```bash
LLM_FW_AUDIT_ENABLED=true llm-fw start --standalone
```

Writes newline-delimited JSON to `<LLM_FW_DIR>/audit.jsonl`. Point Vector, Fluent
Bit or any log shipper at it. It rotates at 64 MiB and keeps one previous
generation, so plan for roughly 128 MiB.

Every record carries the **ruleset version** that produced the verdict, so an
audit read months later does not depend on knowing which build was deployed.
Detection carries an identifier separate from the npm version, because a patch
release can move a threshold and a feature release can leave detection untouched.
A CI gate hashes every file that can change a verdict and fails until the version
is cut, so the identifier cannot drift from the rules it names.

Prompt text is **not** written unless you ask for it. Payloads carry customer
data and secrets, so `LLM_FW_AUDIT_PAYLOADS=true` is a deliberate opt-in, and
turning it on changes what your retention policy has to cover.

`LLM_FW_AUDIT_WEBHOOK=<url>` additionally POSTs batches to a collector. The file
stays the durable record, and the shipper drops rather than backlogs when the
collector is down. `LLM_FW_AUDIT_FILE` relocates the file.

---

## Health checks and monitoring

**Health endpoints exist only on the gateway listener.**

| Route | Port | Meaning |
| --- | --- | --- |
| `GET /healthz` | 8081 | Process is up |
| `GET /livez` | 8081 | Process is up |
| `GET /readyz` | 8081 | `200` once the embedding model has loaded, `503` if it has not |

There is no health endpoint on the dashboard and none on the forward proxy. If
you run `--standalone` without `--gateway`, your options are a TCP connect to
8080 or `GET /metrics` on 7731.

`/metrics` on the dashboard port serves Prometheus text exposition behind the
same auth gate as every other dashboard route. Counters:
`llmfw_requests_total{surface}`, `llmfw_blocks_total{stage}`,
`llmfw_warns_total{stage}`, `llmfw_events_total{kind}`. A histogram
`llmfw_scan_duration_ms` (buckets 5 to 2500 ms) tracks pipeline scan latency.
Gauges `llmfw_model_loaded{model="embedding"|"classifier"}` report whether each
model has finished initialising. On by default; disable with
`dashboard.metrics: false` or `LLM_FW_METRICS_ENABLED=false`.

Four alerts worth having: `llmfw_model_loaded` stuck at 0, a `llmfw_blocks_total`
rate that jumps after a deploy (usually a new false positive, not an attack),
`llmfw_scan_duration_ms` p99 climbing, and the process restarting, which
regenerates any unpinned token.

---

## The judge (Ollama), optional

Stage 3 is off by default and never fatal: a failed call returns an `ERROR`
verdict and the pipeline continues on stages 1 and 2.

```bash
LLM_FW_JUDGE_ENABLED=true LLM_FW_OLLAMA_URL=http://ollama:11434 llm-fw start --standalone
```

Default model is `qwen2.5:3b`, overridable with `LLM_FW_JUDGE_MODEL`. Default
Ollama URL is `http://localhost:11434`.

`llm-fw setup-judge` is **interactive** and unusable in a container or a unit
file: it prompts for a model choice and shells out to `ollama pull`. On a server,
pull the model yourself and set the environment variables.

`LLM_FW_JUDGE_BLOCK=true` makes the judge synchronous and blocking. It is
asynchronous by default, which means it observes and records rather than
refusing. Turning it on adds the judge's latency to every request that reaches
stage 3.

---

## Upgrades

1. Read the [CHANGELOG](../../CHANGELOG.md) for the versions you are crossing.
2. Snapshot `LLM_FW_DIR`, or at minimum `ca.key` and `suppressions.json`.
3. Upgrade: `npm install -g llm-fw@<version>`, or pull the new image tag.
4. Restart. Ports, bind hosts, `proxy.mode`, `bypass` and `targets` are cold
   settings; a running process will not pick them up.
5. Check `/readyz` (gateway) or `/metrics` (dashboard) before returning traffic.
6. Confirm `llmfw_model_loaded{model="embedding"}` is 1. A firewall that cannot
   load its embedding model is running on stage 1 alone.

Do not delete `LLM_FW_DIR` as part of an upgrade. A new CA invalidates every
client's trust store in one step.

---

## Hardening checklist

- [ ] All three tokens pinned in the environment, not generated per process.
- [ ] Three different token values.
- [ ] Dashboard bound to `127.0.0.1`, reached over SSH or `port-forward`.
- [ ] `proxy.requireAuth` left alone (never `false` on a non-loopback bind).
- [ ] Proxy port reachable only from the client subnet.
- [ ] `LLM_FW_DIR` mode `0700`, owned by the service user.
- [ ] `ca.key` in your backup set and in your key-rotation plan.
- [ ] Service runs as a dedicated non-root user.
- [ ] `LLM_FW_AUDIT_PAYLOADS` left off unless retention policy covers prompts.
- [ ] `LLM_FW_BYPASS` not set.
- [ ] Provider keys supplied as `LLM_FW_GATEWAY_KEY_*`, so clients never hold them.
- [ ] Clients told which hosts to exclude (see the `NO_PROXY` note below).

---

## Limitations to know before you commit

These are properties of the current implementation, verified in the source. They
are the things that surprise operators after the fact.

**Plain HTTP through the proxy does not work.** The proxy server registers a
`connect` handler and no `request` handler, so it answers `CONNECT` only. A
client that sets `HTTP_PROXY` and then fetches an `http://` URL gets no response
until its own timeout fires. Set `HTTPS_PROXY` only.

**`NO_PROXY` is not implemented.** It is not read anywhere in the product. A
client that sets `HTTPS_PROXY` sends **all** of its HTTPS traffic across the
network to your server, including internal services and package registries.
Non-provider hosts are tunneled without decryption, but they still transit the
box and still pass the URL filter, which blocks on high-entropy hostname labels
and can therefore refuse some legitimate hashed CDN hosts. Tell clients to scope
the variable to the shells that need it rather than exporting it globally.

**Sinkhole mode is loopback-only by construction** and is disabled under
`--standalone`. It cannot serve remote clients. That matters because the sinkhole
is the documented answer for Node.js tools using `fetch`/`undici`, which ignore
proxy variables. Those tools have no remote answer in proxy mode; route them
through the gateway instead.

**The CRL distribution point in every issued certificate is
`http://127.0.0.1:7731/crl`,** hardcoded. On a remote client that address is the
client's own machine.

**Quotas and stateful detection are per-process.** DoS quotas, per-tenant quotas
and cross-request crescendo tracking are in-memory. They do not aggregate across
replicas.

**`--gateway` and `--observe` do not appear in `llm-fw --help`.** They work. The
usage text documents only `--standalone`.

**`llm-fw setup --sinkhole` is a silent no-op.** Only `--proxy-only` is
implemented.

**Nothing gates the firewall on a licence.** No mode, including a shared
commercial server, is stopped or degraded by licence state. The obligation is
contractual, not technical: running llm-fw inside a for-profit organisation,
including as a shared standalone server, needs a commercial licence. See
[LICENSING](../LICENSING.md) and the [licence terms](../../README.md#license).

---

## Troubleshooting

**Clients get `407 Proxy Authentication Required`.** The proxy is bound off-host
and wants a token. Either the client is not sending one, or the server generated
a fresh one at its last restart. Pin `LLM_FW_PROXY_TOKEN` and put the credential
in the client's proxy URL: `http://llm-fw:TOKEN@host:8080`.

**Clients get TLS errors against provider hosts.** The CA is not trusted by that
client's runtime. Node needs `NODE_EXTRA_CA_CERTS`, Python httpx needs
`SSL_CERT_FILE`, Python requests needs `REQUESTS_CA_BUNDLE`, and the OS store is
separate from all of them. See [Client setup](client-setup.md#install-the-ca).

**A remote client cannot reach the gateway at all.** `--gateway` alone binds
loopback. Add `--standalone` or set `LLM_FW_GATEWAY_BIND=0.0.0.0`.

**Clients get a TLS error against the gateway itself.** The gateway serves plain
HTTP unless `LLM_FW_GATEWAY_TLS_CERT` and `LLM_FW_GATEWAY_TLS_KEY` are set.
Either terminate TLS in front of it or point the client at `http://`.

**The gateway returns 404.** It never guesses an upstream. The path did not match
a provider slug, a provider-specific shape, or a bare `/v1/...` route to the
default provider. See [Gateway mode](gateway-mode.md).

**Requests are not being scanned, and nothing is blocked.** Check that the host
is in `targets` or `interceptDomains`; anything else is tunneled uninspected.
Check that `LLM_FW_BYPASS` is not set. Check that enforcement is not `observe`.

**A config change did nothing.** Ports, bind hosts, `proxy.mode`, `bypass`,
`targets` and `interceptDomains` are cold. Restart. Detection toggles and
thresholds hot-reload from `<LLM_FW_DIR>/config.json`.

**A boolean environment variable did not take effect.** It must be exactly
`true`. `1` and `yes` both mean false.

**A probe against `/readyz` fails during startup.** The gateway binds only
after the embedding model has loaded, so a probe fired during that window
usually sees a refused connection rather than a 503. Either way the instance is
not ready. On first run outside the Docker image the model is still
downloading; check that `LLM_FW_MODEL_DIR` is writable by the service user.
This is what the chart's `startupProbe` window exists to cover.

**The service starts but cannot read its CA.** `setup` was run as a different
user, or with a different `LLM_FW_DIR`. The directory is mode `0700`. Re-run
`setup --proxy-only` as the service user with the same `LLM_FW_DIR`.

---

Next: [Client setup](client-setup.md) ·
[Gateway mode](gateway-mode.md) ·
[Configuration reference](configuration.md)
