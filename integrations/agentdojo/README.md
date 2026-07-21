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

Output is two markdown tables — ASR (lower is better) and no-attack Utility
(higher is better) — per pipeline × suite, plus a `results.json`.

## Configuration

| Flag / env | Meaning |
|---|---|
| `--model` | Agent LLM id (e.g. `gpt-4o-mini`, `claude-3-5-sonnet-…`). Needs the matching API key. |
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
| `test_llm_fw_detector.py` | No-keys smoke test of the bridge. |
| `requirements.txt` | Pinned AgentDojo version this adapter targets. |

The Node side is `scripts/scan-server.ts` (bridge) and `test/api/scan-server.test.ts`.

## Caveats

- **AgentDojo API drift.** `pipeline.py`/`run_agentdojo.py` target the pinned
  `agentdojo` version in `requirements.txt`. Newer releases move modules; the
  code raises clear, located errors when its assumptions break.
- **Cost.** A full four-suite run makes thousands of agent LLM calls. Start with
  one suite (`--suites banking`) and a cheap model to sanity-check wiring.
- **This repo ships the harness, not the scores.** Numbers depend on your chosen
  agent model and API budget; record them in `docs/BENCHMARK-AGENTDOJO.md`.
