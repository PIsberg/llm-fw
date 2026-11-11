# llm-fw × AgentDojo

Run the [AgentDojo](https://github.com/ethz-spylab/agentdojo) agent-security
benchmark with **llm-fw as the prompt-injection defense**, and measure what a
static corpus can't: whether llm-fw actually **blocks injected _actions_ inside
a live tool-calling agent loop**, and at what cost to normal task utility.

## Why this exists

llm-fw's own benchmark (`docs/BENCHMARK.md`) scores detection over *labelled
text corpora* — including InjecAgent on the `tool_result` surface (95.2% recall
/ 0% FPR). That answers "does it classify attacker text correctly?" It does not
answer "does it stop the agent from *doing* the attacker's bidding?" AgentDojo
does: it runs a real agent over realistic tasks (banking, Slack, travel,
workspace), injects attacker instructions into tool outputs, and reports:

- **ASR** (Attack Success Rate) — did the injected instruction actually execute?
- **Utility** — did the agent still complete the legitimate task?

`LlmFwDetector` drops into the **exact pipeline slot** AgentDojo uses for its
built-in `transformers_pi_detector` defense, so `undefended` vs `llm-fw` vs
`transformers_pi_detector` is a genuine head-to-head on identical tasks/attacks.

## Architecture

```
AgentDojo (Python)                         llm-fw (Node/TS)
┌───────────────────────────┐              ┌────────────────────────┐
│ ToolsExecutionLoop         │  POST /scan  │ scripts/scan-server.ts │
│   ToolsExecutor            │  {text,      │   createFirewall()     │
│   LlmFwDetector  ──────────┼──surface}───▶│   → Pipeline.run()     │
│   (this integration)       │◀──{action}───│   (same as the proxy)  │
│   LLM                      │              └────────────────────────┘
└───────────────────────────┘
```

The detector scans each tool output on the **`tool_result` surface** — the same
indirect-injection surface llm-fw's InjecAgent benchmark uses — and aborts the
agent (`AbortAgentError`) when llm-fw returns `action: "block"`.

## Run it

```bash
# 1. Start the llm-fw bridge (repo root). Leave it running.
npm run scan-server            # → http://127.0.0.1:8790

# 2. Install the Python side.
pip install -r integrations/agentdojo/requirements.txt

# 3. Smoke-test the bridge (no agent LLM / API key needed).
pytest integrations/agentdojo/test_llm_fw_detector.py -v

# 4. Full benchmark (needs an agent model + its API key).
cd integrations/agentdojo
export OPENAI_API_KEY=...       # or ANTHROPIC_API_KEY for a Claude --model
python run_agentdojo.py --model gpt-4o-mini \
    --pipelines undefended,llm-fw,transformers_pi_detector \
    --suites banking,slack --attack important_instructions \
    --json-out results.json
```

### With a local model, no API key

`--base-url` sends the agent to any OpenAI-compatible server (Ollama, vLLM,
llama.cpp) with native tool calling at temperature 0. `--user-tasks` and
`--injection-tasks` run a fixed subset, which a CPU-bound model needs:

```bash
ollama serve &                   # with the model pulled: ollama pull qwen2.5:14b
pip install "agentdojo[transformers]==0.1.35"   # the DeBERTa baseline needs torch
bash scripts/run-agentdojo.sh    # repo root; settings are AGENTDOJO_* env vars
```

The script starts the scan server on the default configuration (a fresh
`LLM_FW_DIR`, so your own `~/.llm-fw/config.json` does not tune the defense),
runs the 16 banking user tasks without an attack and against
`injection_task_0` through all three pipelines, and stops the server. The
variables it reads are listed at its top. A model too small to do the tasks
measures nothing: qwen2.5:3b and qwen2.5-coder:7b completed 0 of 2 banking
tasks, and an agent that cannot follow the user cannot follow an injection
either. qwen2.5:14b completed 1 of 2 at about 3 minutes per task on a 12-core
laptop CPU, and the default subset (99 runs over three pipelines) took 4 hours.
Its results are in
[BENCHMARK-AGENTDOJO.md](../../docs/BENCHMARK-AGENTDOJO.md#local-run-qwen2514b-banking-one-injection-task).
The 14b model holds about 9.5 GB of memory while it runs.

Output is two markdown tables — ASR (lower is better) and no-attack Utility
(higher is better) — per pipeline × suite, plus a `results.json`.

## Configuration

| Flag / env | Meaning |
|---|---|
| `--model` | Agent LLM id (e.g. `gpt-4o-mini`, `claude-3-5-sonnet-…`), which needs the matching API key; with `--base-url`, the id the server knows (`qwen2.5:14b`). |
| `--base-url` | OpenAI-compatible server for the agent, e.g. `http://127.0.0.1:11434/v1`. `$AGENT_API_KEY` is sent if it wants one. |
| `--user-tasks` | Comma list of user task ids (default: all). |
| `--injection-tasks` | Comma list of injection task ids run under attack (default: all). |
| `--pipelines` | `undefended`, `llm-fw`, `transformers_pi_detector` (comma list). |
| `--suites` | AgentDojo suites: `banking,slack,travel,workspace`. |
| `--attack` | AgentDojo attack name (default `important_instructions`). |
| `--block-on-warn` | Also abort on llm-fw `warn` verdicts (default: only `block`). |
| `LLM_FW_SCAN_URL` | Bridge URL (default `http://127.0.0.1:8790`); `--scan-url` overrides. |
| `LLM_FW_*` | Any llm-fw config env var (thresholds, classifier, judge) is honoured by the scan server exactly as by the proxy — tune the defense without touching this code. |

To evaluate llm-fw's **trained classifier** or **judge** stages, set the
corresponding `LLM_FW_*` env vars (or `~/.llm-fw/config.json`) *before* starting
`scan-server` — it goes through the same `createFirewall()` → `loadConfig()`
layering as every other entrypoint.

## Files

| File | Role |
|---|---|
| `llm_fw_detector.py` | `LlmFwDetector(PromptInjectionDetector)` — calls the scan server. |
| `pipeline.py` | Builds `undefended` / `llm-fw` / `transformers_pi_detector` pipelines. |
| `run_agentdojo.py` | CLI: runs suites, aggregates ASR + utility, prints tables + JSON. |
| `test_llm_fw_detector.py` | No-keys smoke test of the bridge (needs the scan server). |
| `test_pipeline.py` | Offline tests: local-model routing, path-safe names, a task subset run with a stub agent. |
| `requirements.txt` | Pinned AgentDojo version this adapter targets. |

The Node side is `scripts/scan-server.ts` (bridge) and `test/api/scan-server.test.ts`;
`scripts/run-agentdojo.sh` wraps a local-model run.

## Caveats

- **AgentDojo API drift.** `pipeline.py`/`run_agentdojo.py` target the pinned
  `agentdojo` version in `requirements.txt`. Newer releases move modules; the
  code raises clear, located errors when its assumptions break.
- **Cost.** A full four-suite run makes thousands of agent LLM calls. Start with
  one suite (`--suites banking`) and a cheap model to sanity-check wiring. A
  local model costs time instead: banking alone is 16 user tasks and 144
  attacked pairs per pipeline.
- **Windows paths.** Pipeline names become log directories, so characters a
  Windows path cannot hold (the `:` in `qwen2.5:14b`) are replaced with `_`.
- **This repo ships the harness, not the scores.** Numbers depend on your chosen
  agent model and API budget; record them in `docs/BENCHMARK-AGENTDOJO.md`.
