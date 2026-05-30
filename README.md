# llm-fw

A local prompt injection firewall that intercepts traffic between your tools and LLM APIs (Anthropic, Google Gemini) before it leaves your machine. Malicious prompts are blocked and logged; clean ones are forwarded transparently.

No changes to your code. No cloud dependencies. Boots in under 2 seconds.

---

## How it works

llm-fw sits between your client and the API using a standard HTTP proxy (`HTTPS_PROXY`). It terminates TLS locally, extracts the prompt from the request body, runs a three-stage detection pipeline, and either forwards the request or returns a 403. All blocked requests appear in a local web dashboard at `localhost:7731`.

Detection pipeline:
1. **Heuristic scoring** — weighted phrase matching (< 1ms)
2. **Embedding similarity** — cosine similarity against 100 known attack vectors using a 30MB local ONNX model (< 20ms warm)
3. **Judge LLM** — local Ollama model, async by default (opt-in)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full technical detail.

---

## Prerequisites

- **Node.js 22+**
- A terminal with permission to install a root CA certificate (one-time, for TLS interception)
- _Optional for Stage 3:_ [Ollama](https://ollama.com) with `phi3` or `llama3.2:3b` pulled

---

## Installation

```bash
npm install -g llm-fw
# or run without installing:
npx llm-fw <command>
```

---

## Quick Start (Recommended: HTTPS_PROXY mode)

No admin rights required after the one-time CA setup.

**Step 1 — Set up the local CA and download the model (~30MB, once only):**

```bash
llm-fw setup
```

This generates a local certificate authority, installs it to your OS trust store, and pre-warms the embedding model cache.

> **Windows:** run the terminal as Administrator for the `certutil` CA install step.
> **macOS/Linux:** you will be prompted for your password.

**Step 2 — Start the proxy and dashboard:**

```bash
llm-fw start
```

Output:
```
Proxy listening on http://localhost:8080
Dashboard at    http://localhost:7731
```

**Step 3 — Point your tools at the proxy:**

```bash
# In your shell, before running any LLM tool:
export HTTPS_PROXY=http://localhost:8080        # macOS / Linux
$env:HTTPS_PROXY = "http://localhost:8080"      # PowerShell
set HTTPS_PROXY=http://localhost:8080           # Windows cmd
```

Any tool that respects `HTTPS_PROXY` — the Anthropic CLI, `curl`, Python scripts using `httpx` or `requests`, Node.js `fetch` — will now route through the firewall automatically.

**Step 4 — Open the dashboard:**

Visit [http://localhost:7731](http://localhost:7731) to see live blocked events. Use the **Playground** tab to test any prompt interactively.

**Stop:**

```bash
llm-fw stop
```

---

## Advanced: DNS Sinkhole Mode

If your tool does **not** support `HTTPS_PROXY` (e.g. a native binary that ignores the env var), use sinkhole mode. This modifies your system hosts file so all traffic to `api.anthropic.com` is routed through the proxy — no env var needed.

Requires admin/root. The hosts file is restored automatically on `stop` or process exit.

```bash
llm-fw setup --sinkhole   # adds hosts entries (requires elevation)
llm-fw start
llm-fw stop               # removes hosts entries
```

---

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

All fields are optional — defaults are shown above. Full reference in [spec.md](spec.md).

**Environment variable overrides:**

```bash
LLM_FW_PROXY_PORT=9090
LLM_FW_EMBEDDING_BLOCK_THRESHOLD=0.80
LLM_FW_JUDGE_ENABLED=true
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `llm-fw setup` | Generate CA cert, install to trust store, download model |
| `llm-fw setup --sinkhole` | Also write hosts file entries (requires admin) |
| `llm-fw start` | Start proxy and dashboard |
| `llm-fw stop` | Stop processes; restore hosts file if sinkhole mode |
| `llm-fw status` | Show running state, active mode, dashboard URL |

---

## Dashboard

Open [http://localhost:7731](http://localhost:7731) while the proxy is running.

- **Events tab** — live feed of every blocked or warned request: timestamp, detection stage, risk score, cosine similarity, target API, payload preview.
- **Playground tab** — paste any prompt and click Analyze to see a full stage-by-stage breakdown without needing a real client.

---

## Supported platforms

| Platform | HTTPS_PROXY mode | Sinkhole mode |
|----------|-----------------|---------------|
| Windows 11 | Yes | Yes (admin required) |
| macOS 13+ | Yes | Yes (sudo required) |
| Ubuntu 22+ | Yes | Yes (sudo required) |

---

## Documentation

- [spec.md](spec.md) — full product specification
- [PLAN.md](PLAN.md) — implementation plan
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system architecture, sequence diagrams, class diagrams
