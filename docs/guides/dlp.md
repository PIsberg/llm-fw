[llm-fw](../../README.md) > [Documentation](../README.md) > Data Loss Prevention (DLP)

# Data Loss Prevention (DLP)

Beyond inbound prompt injection, `llm-fw` runs a **Stage 0** pre-flight scan that inspects outbound prompts for sensitive local data before they ever leave your machine. This mitigates accidental leakage of secrets and PII into third-party LLM providers (a GDPR / SOC2 exposure).

The scan only runs on recognised LLM JSON requests (e.g. Anthropic `/v1/messages`, Gemini `generateContent`) — binary/file uploads are skipped — and is designed to complete in well under 5 ms.

### Detectors

| Detector key | What it catches |
|--------------|-----------------|
| `aws` | Amazon access key IDs (`AKIA…`/`ASIA…` + the other 20-char AWS prefixes), keyword-adjacent secret access keys, STS session tokens (`FwoG…`), and MWS auth tokens (`amzn.mws.…`) |
| `google` | Google API keys (`AIza…` — Cloud / Gemini / Maps / Firebase) and OAuth access/refresh tokens (`ya29.…`, `1//0…`) |
| `openai` | OpenAI API keys (`sk-proj-`/`sk-svcacct-`/`sk-admin-…` and legacy `sk-` + 48 chars) |
| `anthropic` | Anthropic API keys (`sk-ant-…`) |
| `openrouter` | OpenRouter API keys (`sk-or-v1-…`) |
| `groq` | Groq API keys (`gsk_…`) |
| `xai` | xAI / Grok API keys (`xai-…`) |
| `perplexity` | Perplexity API keys (`pplx-…`) |
| `huggingface` | Hugging Face access tokens (`hf_…`) |
| `replicate` | Replicate API tokens (`r8_…`) |
| `fireworks` | Fireworks AI API keys (`fw_…`) |
| `nvidia` | NVIDIA API keys (`nvapi-…`) |
| `anyscale` | Anyscale API keys (`esecret_…`) |
| `langsmith` | LangSmith / LangChain API keys (`lsv2_pt_…`/`lsv2_sk_…`) |
| `github` | GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` + 36 chars) and fine-grained PATs (`github_pat_…`) |
| `gitlab` | GitLab personal / project access tokens (`glpat-…`) |
| `npm` / `pypi` / `rubygems` / `dockerhub` | Package-registry tokens (`npm_…`, `pypi-AgEI…`, `rubygems_…`, `dckr_pat_…`) |
| `vault` / `terraform` | HashiCorp Vault tokens (`hvs.`/`hvb.`) and Terraform Cloud tokens (`….atlasv1.…`) |
| `databricks` / `atlassian` | Databricks PATs (`dapi…`) and Atlassian/Jira API tokens (`ATATT3…`/`ATCTT3…`) |
| `slack` | Slack tokens (`xoxb-`/`xoxp-`/`xoxa-`/`xoxr-`/`xoxs-…`) and incoming-webhook URLs (`hooks.slack.com/services/…`) |
| `discord` / `telegram` | Discord webhook URLs + bot tokens, Telegram bot tokens (`<id>:<secret>`) |
| `stripe` | Stripe live secret + restricted keys (`sk_live_…`/`rk_live_…`) and webhook signing secrets (`whsec_…`) |
| `square` / `shopify` | Square access/OAuth tokens (`sq0atp-`/`sq0csp-…`) and Shopify tokens (`shpat_`/`shpss_…`) |
| `twilio` / `sendgrid` / `mailgun` / `mailchimp` | Comms/email provider keys (`AC…`/`SK…`, `SG.…`, `key-…`, `…-usN`) |
| `azure` / `digitalocean` | Azure Storage account keys (`AccountKey=…`) and DigitalOcean tokens (`dop_v1_…`) |
| `newrelic` / `sentry` | New Relic API keys (`NRAK-…`) and Sentry DSNs with embedded secret |
| `private_keys` | RSA / EC / OpenSSH / DSA / PGP private-key headers |
| `mongodb` | MongoDB SRV connection URIs with embedded credentials |
| `connection_uri` | Any `scheme://user:password@host` connection string (Postgres/MySQL/Redis/AMQP/HTTP basic-auth) |
| `jwt` | JSON Web Tokens (`eyJ….eyJ….…`) |
| `entropy` | High-entropy generic secrets adjacent to credential keywords (`password=`/`pwd=`/`secret:`/`token=`/`api_key=`/`access_key=`/`auth:`/`credential=`/`key=`, Shannon entropy > 4.0, length > 20) **and** `Authorization: Bearer <token>` headers (the `Bearer` keyword alone is sufficient, no entropy gate) |
| `pii` | US SSNs and credit-card numbers (validated with the Luhn algorithm) |

Each detected secret maps to a provider-specific redaction marker such as `[REDACTED_OPENAI_KEY]`, `[REDACTED_ANTHROPIC_KEY]`, `[REDACTED_GOOGLE_API_KEY]`, `[REDACTED_AWS_KEY]`, `[REDACTED_GITHUB_TOKEN]`, `[REDACTED_CREDIT_CARD]`, `[REDACTED_BEARER_TOKEN]`, or `[REDACTED_SECRET]`. Redaction patches each secret **at its exact matched offset** (not a global string replace), so a token that also appears elsewhere as benign data is never redacted by coincidence.

> Providers whose keys carry no distinctive prefix (e.g. Mistral, Cohere, Together, DeepSeek, Azure OpenAI) are still caught by the `entropy` detector when they appear next to a credential keyword (`api_key=`, `token:`, `Authorization: Bearer …`).

> The firewall never logs the raw secret value — dashboard events record only the **type** of secret found (e.g. `GITHUB_TOKEN`).

### Modes

| Mode | Behaviour |
|------|-----------|
| `block` | Aborts the request with `403 Forbidden` and `{ "error": "sensitive data detected", "type": "…" }`. |
| `redact` (default) | Rewrites the JSON payload, replacing each secret with its marker, then forwards the request transparently. JSON structure and escaping are preserved (the raw string is patched in place — no re-serialisation). |
| `audit` | Forwards the request unmodified, but logs a high-priority `dlp` event to the dashboard. |

### Configuration

```json
{
  "dlp": {
    "enabled": true,
    "mode": "redact",
    "detectors": [
      "aws", "google", "azure", "digitalocean",
      "openai", "anthropic", "openrouter", "groq", "xai", "perplexity",
      "huggingface", "replicate", "fireworks", "nvidia", "anyscale", "langsmith",
      "github", "gitlab", "npm", "pypi", "rubygems", "dockerhub", "vault",
      "terraform", "databricks", "atlassian", "newrelic", "sentry",
      "stripe", "square", "shopify", "slack", "discord", "telegram",
      "twilio", "sendgrid", "mailgun", "mailchimp",
      "private_keys", "mongodb", "connection_uri", "jwt", "entropy", "pii"
    ]
  }
}
```

Environment overrides:

| Variable | Effect |
|----------|--------|
| `LLM_FW_DLP_ENABLED` | `true`/`false` — enable or disable the DLP stage |
| `LLM_FW_DLP_MODE` | `block` \| `redact` \| `audit` |

Detected events appear in the dashboard under the **Data Loss** badge with a `dlp` stage chip.
