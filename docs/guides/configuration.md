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
LLM_FW_JUDGE_ENABLED=true
```

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
