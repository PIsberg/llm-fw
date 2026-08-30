[llm-fw](../../README.md) > [Documentation](../README.md) > Configuration reference

# Configuration reference

Where config is read from, the full key reference, and what the firewall does when a stage cannot run.

## Configuration

Create `.llm-fw.json` in your project root, or `~/.llm-fw.json` for a global default:

```json
{
  "proxy": {
    "mode": "proxy",
    "port": 8080
  },
  "detection": {
    "heuristicBlockThreshold": 50,
    "embeddingBlockThreshold": 0.85,
    "judgeEnabled": false,
    "judgeModel": "phi3",
    "judgeBlock": false
  },
  "dashboard": {
    "port": 7731
  }
}
```

All fields are optional — defaults are shown above. Full key reference below and in [ARCHITECTURE.md](../ARCHITECTURE.md).

**Environment variable overrides:**

```bash
LLM_FW_PROXY_PORT=9090
LLM_FW_EMBEDDING_BLOCK_THRESHOLD=0.80
LLM_FW_EMBEDDING_MAX_CHUNKS=24
LLM_FW_JUDGE_ENABLED=true
```

**Scan cost on long prompts.** `detection.embeddingMaxChunks` (default `24`)
bounds how much of one piece of text the embedding stage encodes. Above it the
text is sampled evenly rather than truncated, and the heuristic stage still
reads every byte. Raising it costs latency roughly linearly; `0` removes the
bound entirely, which is how a 1 MB prompt used to take 423 s. See
[detection-stages.md](detection-stages.md#cost-on-long-prompts).

**Classifier surface scoping.** The opt-in trained classifier
(`detection.classifier`) can be limited to specific scan surfaces via
`detection.classifier.surfaces` (also `LLM_FW_CLASSIFIER_SURFACES`,
comma-separated). The default list is `prompt, memory, tool_result, document`:
the trusted `system` and `tool_definition` surfaces are excluded because the
model false-positives on developer-authored instruction text at every
threshold. Scoping it to only the untrusted data surfaces turns it into an
indirect-injection detector with no false-positive cost on user prompts:

```json
{
  "detection": {
    "classifier": { "enabled": true, "surfaces": ["tool_result", "document"] },
    "surfaces": { "tool_result": { "classifierBlockThreshold": 0.999 } }
  }
}
```

`classifierBlockThreshold` under `detection.surfaces` raises the block bar on
that surface only; the second line is optional and trades recall for precision
on benign tool output. Measured numbers for both settings are in
[BENCHMARK.md](../BENCHMARK.md).

**Model cache and first start.** The first run downloads the ONNX weights from
HuggingFace, which is why `start` can sit on `Loading embedding model...` for a
while. Point `LLM_FW_MODEL_DIR` at a persistent path to download once and reuse
it across restarts, containers and CI:

```bash
LLM_FW_MODEL_DIR=/var/lib/llm-fw/models
LLM_FW_MODEL_LOAD_TIMEOUT_MS=600000   # 0 waits indefinitely
```

Without a shared cache each fresh state directory re-downloads. While a load is
in flight llm-fw logs a heartbeat every 30s; if it exceeds the timeout the ML
stage is disabled and the firewall starts anyway, with the heuristic, DLP, MCP,
URL and DoS stages still running — the same outcome as any other model-load
failure, so an unreachable HuggingFace degrades detection rather than blocking
startup.

## Logging

Structured JSON to `stdout` for informational records and `stderr` for
problems, with one correlation id per request.

```bash
LLM_FW_LOG_LEVEL=info     # debug | info | warn | error | fatal (default info)
LLM_FW_LOG_FORMAT=json    # json | pretty (default: pretty on a terminal, json otherwise)
```

The default is right without configuring it: a person running `llm-fw start`
in a terminal gets prose, and the same binary in a container gets JSON a
collector can parse.

Both are read directly from the environment rather than through the config
object, and so are absent from the table below. Logging starts before
`loadConfig()` runs, and a logger that cannot report a configuration failure
because it is waiting on the configuration is no use.

**Request correlation.** The gateway gives every request an id, honouring an
inbound `x-request-id` when the caller sends one and minting a UUID otherwise,
and echoes it back in the `x-request-id` response header. Every log record
written while serving that request carries it, however deep in the detection
pipeline it was written. So "my request was blocked" has one token that appears
both in what the caller holds and in what the operator greps.

**What is never logged.** Prompt text, tool results, retrieved documents and
credentials. This is a firewall for traffic that contains exactly those things;
payload capture is a deliberate, separate decision behind
`audit.includePayloads`.

## Environment variable reference

Every `LLM_FW_*` variable, the config key it writes and its default. Applied after the config files, so an environment variable always wins. Two traps worth knowing before you read the table: booleans are strictly the string `true` (`1` and `yes` both mean false), and an empty value is ignored rather than treated as false.

`LLM_FW_GATEWAY_KEY_<SLUG>` is deliberately absent. Provider keys are read straight from the environment and never enter the config object, so the dashboard settings view cannot read them back out.

<!-- CONFIG-REFERENCE-START -->

_82 variables, generated from `ENV_OVERRIDES` in `src/config/config.ts` by `npm run config:reference`. Do not edit by hand._

| Variable | Sets | Default |
| --- | --- | --- |
| `LLM_FW_ASCII_SMUGGLING_ENABLED` | `asciiSmuggling.enabled` | `true` |
| `LLM_FW_AUDIT_ENABLED` | `audit.enabled` | `false` |
| `LLM_FW_AUDIT_FILE` | `audit.file` | _unset_ |
| `LLM_FW_AUDIT_PAYLOADS` | `audit.includePayloads` | `false` |
| `LLM_FW_AUDIT_WEBHOOK` | `audit.webhookUrl` | _unset_ |
| `LLM_FW_BYPASS` | `proxy.bypass` | `false` |
| `LLM_FW_CLASSIFIER_ENABLED` | `detection.classifier.enabled` | `false` |
| `LLM_FW_CLASSIFIER_ESCALATE` | `detection.classifier.escalateThreshold` | `0.5` |
| `LLM_FW_CLASSIFIER_SURFACES` | `detection.classifier.surfaces` | `4 entries` |
| `LLM_FW_CLASSIFIER_THRESHOLD` | `detection.classifier.blockThreshold` | `0.9` |
| `LLM_FW_CRESCENDO_CROSS_REQUEST` | `crescendo.crossRequest` | `false` |
| `LLM_FW_CRESCENDO_ENABLED` | `crescendo.enabled` | `true` |
| `LLM_FW_CRESCENDO_MODE` | `crescendo.mode` | `block` |
| `LLM_FW_DASHBOARD_BIND` | `dashboard.bindHost` | `127.0.0.1` |
| `LLM_FW_DASHBOARD_PORT` | `dashboard.port` | `7731` |
| `LLM_FW_DASHBOARD_TOKEN` | `dashboard.authToken` | _unset_ |
| `LLM_FW_DLP_ENABLED` | `dlp.enabled` | `true` |
| `LLM_FW_DLP_MODE` | `dlp.mode` | `redact` |
| `LLM_FW_DOS_ENABLED` | `dos.enabled` | `true` |
| `LLM_FW_DOS_MAX_RPM` | `dos.maxRequestsPerMinute` | `60` |
| `LLM_FW_DOS_MAX_TOKENS_PER_SESSION` | `dos.maxTokensPerSession` | `500000` |
| `LLM_FW_DOS_TOKEN_WINDOW_MS` | `dos.tokenBudgetWindowMs` | `3600000` |
| `LLM_FW_EMBEDDING_BLOCK_THRESHOLD` | `detection.embeddingBlockThreshold` | `0.86` |
| `LLM_FW_EMBEDDING_MARGIN` | `detection.embeddingMarginThreshold` | `0.02` |
| `LLM_FW_EMBEDDING_MAX_CHUNKS` | `detection.embeddingMaxChunks` | `24` |
| `LLM_FW_EMBEDDING_WARN_THRESHOLD` | `detection.embeddingWarnThreshold` | `0.8` |
| `LLM_FW_ENFORCEMENT` | `enforcement` | _unset_ |
| `LLM_FW_EXTRA_TARGETS` | `extraTargets` | `0 entries` |
| `LLM_FW_FAIL_MODE` | `detection.failMode` | `closed` |
| `LLM_FW_GATEWAY_BIND` | `gateway.bindHost` | `127.0.0.1` |
| `LLM_FW_GATEWAY_DEFAULT_PROVIDER` | `gateway.defaultProvider` | `openai` |
| `LLM_FW_GATEWAY_ENABLED` | `gateway.enabled` | `false` |
| `LLM_FW_GATEWAY_PORT` | `gateway.port` | `8081` |
| `LLM_FW_GATEWAY_REQUIRE_AUTH` | `gateway.requireAuth` | _unset_ |
| `LLM_FW_GATEWAY_TLS_CERT` | `gateway.tls` | _unset_ |
| `LLM_FW_GATEWAY_TLS_KEY` | `gateway.tls` | _unset_ |
| `LLM_FW_GATEWAY_TOKEN` | `gateway.authToken` | _unset_ |
| `LLM_FW_HARMFUL_REQUEST_ENABLED` | `harmfulRequest.enabled` | `true` |
| `LLM_FW_HARMFUL_REQUEST_MODE` | `harmfulRequest.mode` | `block` |
| `LLM_FW_HOT_RELOAD` | `hotReload` | `true` |
| `LLM_FW_HTTPS_PORT` | `proxy.httpsPort` | `8443` |
| `LLM_FW_INDIRECT_INSTRUCTION_ENABLED` | `indirectInstruction.enabled` | `true` |
| `LLM_FW_INDIRECT_INSTRUCTION_MODE` | `indirectInstruction.mode` | `block` |
| `LLM_FW_INTENT_MENTION_ENABLED` | `detection.intentMention` | `true` |
| `LLM_FW_INTERCEPT_DOMAINS` | `proxy.interceptDomains` | `2 entries` |
| `LLM_FW_JUDGE_BLOCK` | `detection.judgeBlock` | `false` |
| `LLM_FW_JUDGE_ENABLED` | `detection.judgeEnabled` | `false` |
| `LLM_FW_JUDGE_MODEL` | `detection.judgeModel` | `qwen2.5:3b` |
| `LLM_FW_JUDGE_UNLESS_BENIGN` | `detection.judgeUnlessBenign` | `false` |
| `LLM_FW_MANYSHOT_ENABLED` | `manyShot.enabled` | `true` |
| `LLM_FW_MANYSHOT_MODE` | `manyShot.mode` | `block` |
| `LLM_FW_MAX_BODY_BYTES` | `proxy.maxBodyBytes` | `10485760` |
| `LLM_FW_MCP_ENABLED` | `mcp.enabled` | `true` |
| `LLM_FW_MCP_GUARDRAILS_ENABLED` | `mcp.guardrailsEnabled` | `true` |
| `LLM_FW_MEMORY_POISONING` | `memoryPoisoning.enabled` | `true` |
| `LLM_FW_MEMORY_POISONING_MODE` | `memoryPoisoning.mode` | `block` |
| `LLM_FW_METRICS_ENABLED` | `dashboard.metrics` | `true` |
| `LLM_FW_MODEL_LOAD_TIMEOUT_MS` | `detection.modelLoadTimeoutMs` | `600000` |
| `LLM_FW_NONTEXT_ENABLED` | `nonText.enabled` | `true` |
| `LLM_FW_NONTEXT_MODE` | `nonText.mode` | `audit` |
| `LLM_FW_NONTEXT_OCR` | `nonText.ocr` | `false` |
| `LLM_FW_OLLAMA_URL` | `detection.ollamaUrl` | `http://localhost:11434` |
| `LLM_FW_PROXY_BIND` | `proxy.bindHost` | `127.0.0.1` |
| `LLM_FW_PROXY_MODE` | `proxy.mode` | `proxy` |
| `LLM_FW_PROXY_PORT` | `proxy.port` | `8080` |
| `LLM_FW_PROXY_REQUIRE_AUTH` | `proxy.requireAuth` | _unset_ |
| `LLM_FW_PROXY_TOKEN` | `proxy.authToken` | _unset_ |
| `LLM_FW_RAG_ENABLED` | `rag.enabled` | `true` |
| `LLM_FW_RESPONSE_CLASSIFIER_ENABLED` | `responseScan.classifier.enabled` | `false` |
| `LLM_FW_RESPONSE_CLASSIFIER_MODEL` | `responseScan.classifier.model` | _unset_ |
| `LLM_FW_RESPONSE_CLASSIFIER_THRESHOLD` | `responseScan.classifier.blockThreshold` | `0.9` |
| `LLM_FW_RESPONSE_HARM_ENABLED` | `responseScan.harmfulCompliance` | `true` |
| `LLM_FW_RESPONSE_SCAN_ENABLED` | `responseScan.enabled` | `true` |
| `LLM_FW_RESPONSE_SCAN_MODE` | `responseScan.mode` | `audit` |
| `LLM_FW_SCAN_SYSTEM_PROMPT` | `detection.scanSystemPrompt` | `false` |
| `LLM_FW_SUPPRESSIONS_ENABLED` | `detection.suppressions` | `true` |
| `LLM_FW_TAINT_ENABLED` | `taint.enabled` | `true` |
| `LLM_FW_TAINT_MODE` | `taint.mode` | `audit` |
| `LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD` | `detection.surfaces.tool_result` |  |
| `LLM_FW_TOOLUSE_SCAN_ENABLED` | `responseScan.toolUse.enabled` | `true` |
| `LLM_FW_TOOLUSE_SCAN_MODE` | `responseScan.toolUse.mode` | `audit` |
| `LLM_FW_WORKER_INFERENCE` | `detection.workerInference` | `false` |

<!-- CONFIG-REFERENCE-END -->

## Failure Semantics

What happens if the detection pipeline itself **fails** — a parser or stage throws on a request it should have scanned? That is a bug (the fuzz suite in `test/fuzz/` exists to keep it from happening), but the outcome must never be undefined behavior. `detection.failMode` makes it explicit:

- **`closed`** (default) — the request is **blocked** with the standard `403` block response (`{ "error": "detection pipeline error — failing closed" }`) and a blocked `error` event appears on the dashboard. Nothing that could not be scanned reaches the provider. This matches the firewall's historical behavior, where a pipeline exception ended the request with an error response instead of forwarding it.
- **`open`** — the request is **forwarded upstream unscanned**, and a warned `error` audit event records the failure (including the stack) on the dashboard. Choose this when availability matters more than a scan gap during a firewall bug.

```json
{ "detection": { "failMode": "closed" } }
```

| Variable | Effect |
|----------|--------|
| `LLM_FW_FAIL_MODE` | `open` / `closed` — any other value is ignored |

Two neighboring escape hatches are unrelated to pipeline errors: `proxy.bypass` (`LLM_FW_BYPASS=true`) turns the whole proxy into a transparent no-inspection tunnel, and upstream/network failures still surface as `502` proxy errors as before.
