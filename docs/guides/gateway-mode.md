[llm-fw](../../README.md) > [Documentation](../README.md) > Gateway mode — point base_url at the firewall (no CA install)

# Gateway mode — point base_url at the firewall (no CA install)

The [standalone server](deployment-server.md#standalone-forward-proxy-server) is a **forward proxy**: it inspects traffic by intercepting TLS to the provider, so every client machine has to trust the llm-fw CA and set `HTTPS_PROXY`. That is fine on a dev box you control and a hard sell everywhere else — managed laptops, CI containers, serverless runtimes.

Gateway mode inverts it. The firewall **is** the endpoint: clients set their SDK's `base_url` and speak ordinary HTTPS to a certificate you already own. No CA to distribute, nothing to configure per machine.

```bash
llm-fw start --gateway
```

Clients then point at it:

```bash
export ANTHROPIC_BASE_URL=https://fw.example.com/anthropic
export OPENAI_BASE_URL=https://fw.example.com/openai/v1
```

Two path shapes are accepted:

| Request path | Routed to |
|---|---|
| `/anthropic/v1/messages`, `/groq/v1/chat/completions`, … | that provider, prefix stripped |
| `/v1/messages` | Anthropic (its own API shape) |
| `/v1beta/models/...:generateContent` | Gemini |
| `/v1/chat/completions` and other bare `/v1/…` | `gateway.defaultProvider` (default `openai`) |

Anything else is a 404 — the gateway never guesses an upstream.

**Client authentication.** Clients present a token as `X-Llm-Fw-Key` (or `Authorization: Bearer`). It is required automatically as soon as the listener is bound off-host; set `LLM_FW_GATEWAY_TOKEN` to pin it, or read the generated one from the startup log.

**Key custody.** Set `LLM_FW_GATEWAY_KEY_<SLUG>` and the gateway holds the provider credential: it replaces whatever the client sent and strips every other credential header, so callers never hold the provider key and cannot route around your attribution.

```bash
export LLM_FW_GATEWAY_KEY_ANTHROPIC=sk-ant-...
export LLM_FW_GATEWAY_KEY_OPENAI=sk-...
```

**TLS.** Run behind a load balancer or ingress that terminates TLS (the common case), or serve it directly with `LLM_FW_GATEWAY_TLS_CERT` / `LLM_FW_GATEWAY_TLS_KEY`.

**Tenants.** One shared token says a caller is authorised and nothing else. Give each team its own:

```json
{
  "gateway": {
    "tenants": {
      "platform":  { "token": "...", "quotaPerMinute": 600 },
      "research":  { "token": "...", "providers": ["anthropic"] },
      "new-team":  { "token": "...", "enforcement": "observe" }
    }
  }
}
```

That buys three things a single token cannot. Every event carries the tenant, so "why did our agent break?" has an answer. Each team gets a per-minute quota, so one runaway loop cannot spend everyone's budget — the refusal is a 429 with `Retry-After`, and it never reaches the provider. And `enforcement: "observe"` puts one team in observation while the rest stay enforced, which is how you onboard a team without either exposing them to day-one false positives or turning the firewall down for everybody.

A tenant token authenticates on its own; the deployment-wide token keeps working alongside them, so adding tenants never locks out the credential already in use. Quotas are per gateway process: with several replicas each enforces its own share, which the Helm chart's `replicaCount` comment spells out.

**Private endpoints.** A self-hosted vLLM or Ollama is a config entry, including a non-standard port and plain HTTP for in-cluster traffic:

```json
{
  "gateway": {
    "providers": {
      "internal": { "host": "vllm.svc.cluster.local", "port": 8000, "protocol": "http", "auth": "bearer" }
    }
  }
}
```

**Health endpoints.** `/healthz` and `/livez` answer immediately; `/readyz` returns 503 until the embedding model is loaded, so a rollout never routes traffic to an instance that cannot scan yet. All three answer before authentication, because a kubelet cannot present a token.

**What differs from the proxy.** The gateway runs the full **request-side** pipeline (DLP + every injection stage). Response-side scanning — exfil URLs, harmful compliance, tool-use argument scanning — currently runs on the forward proxy only; the gateway streams responses through untouched.

| | Forward proxy | Gateway |
|---|---|---|
| Client setup | CA install + `HTTPS_PROXY` | `base_url` only |
| Works in CI / serverless | No | Yes |
| Provider key custody | No | Yes |
| Request-side detection | Yes | Yes |
| Response-side detection | Yes | Not yet |
| Covers non-LLM traffic (URL filter, taint) | Yes | No |
