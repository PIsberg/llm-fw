# AgentDojo Benchmark (agentic injection)

`docs/BENCHMARK.md` measures detection over **labelled text corpora** — "does
llm-fw classify attacker text correctly?" This document is about a different,
harder question that only an *agentic* benchmark can answer:

> When a real tool-calling agent runs a real task and an attacker plants an
> instruction in a tool result, does llm-fw stop the agent from **acting** on
> it — and does the agent still finish its legitimate task?

[AgentDojo](https://github.com/ethz-spylab/agentdojo) (ETH Zürich SPY Lab) is
the standard harness for this. It runs an agent across four suites (banking,
Slack, travel, workspace), injects attacker instructions into tool outputs, and
reports **Attack Success Rate (ASR)** and **utility**.

## Why it complements the corpus benchmark

llm-fw already scores **95.2% recall / 0% FPR** on InjecAgent's `tool_result`
surface (`docs/BENCHMARK.md`, indirect-injection group). But corpus recall is a
*classification* number on isolated strings. AgentDojo closes the loop:

- The same `tool_result` surface, but embedded in a live agent that may or may
  not have *acted* on the injection before/without a block.
- **Utility under the defense** — a detector that aborts the agent on every
  tool output would score a perfect ASR of 0% and be useless. AgentDojo forces
  the honest trade-off into view.
- A **head-to-head** slot: `LlmFwDetector` occupies the exact pipeline position
  AgentDojo uses for its built-in `transformers_pi_detector`
  (`protectai/deberta-v3-base-prompt-injection-v2`), so the two are directly
  comparable on identical tasks and attacks — the "vs. other guardrails"
  comparison `BENCHMARK.md`'s *Honest bounds* section flags as still missing.

## Method

The harness lives in [`integrations/agentdojo/`](../integrations/agentdojo/)
(see its README for setup). llm-fw runs unchanged behind the
`scripts/scan-server.ts` bridge, so the detection pipeline, config, and
thresholds are identical to the proxy. Three pipelines are compared:

| Pipeline | Defense element in the tools loop |
|---|---|
| `undefended` | none — the attack's natural success rate |
| `llm-fw` | `LlmFwDetector` → scan server → real llm-fw pipeline |
| `transformers_pi_detector` | AgentDojo's built-in ProtectAI-deberta detector |

Each is run with no injection (utility floor) and under the
`important_instructions` attack (ASR + utility-under-attack).

```bash
npm run scan-server &                       # llm-fw bridge
cd integrations/agentdojo
python run_agentdojo.py --model gpt-4o-mini \
    --pipelines undefended,llm-fw,transformers_pi_detector \
    --suites banking,slack,travel,workspace \
    --attack important_instructions --json-out results.json
```

## Results

_Not yet run in this repo._ AgentDojo requires an agent LLM and a non-trivial
API budget (thousands of model calls for a full four-suite sweep), so the
numbers depend on the chosen model. The integration and its no-API-keys smoke
test (`test_llm_fw_detector.py`, plus the Node-side `test/api/scan-server.test.ts`)
are verified; the end-to-end scores are not, by design.

When run, paste the two tables here:

**Attack Success Rate — lower is better**

| Pipeline | banking | slack | travel | workspace | mean |
|---|---|---|---|---|---|
| undefended | — | — | — | — | — |
| llm-fw | — | — | — | — | — |
| transformers_pi_detector | — | — | — | — | — |

**Utility (no attack) — higher is better (defense false-positive cost)**

| Pipeline | banking | slack | travel | workspace | mean |
|---|---|---|---|---|---|
| undefended | — | — | — | — | — |
| llm-fw | — | — | — | — | — |
| transformers_pi_detector | — | — | — | — | — |

## Honest bounds

- **Model-dependent.** ASR and utility both move with the agent model; always
  report the `--model` alongside the numbers, and compare pipelines only within
  the same model.
- **Attack-dependent.** `important_instructions` is one attack; AgentDojo ships
  several. A single attack is a data point, not a verdict.
- **Detector-only defense.** This measures llm-fw as a *tool-output detector*.
  It does not exercise the proxy's other surfaces (system/prompt/tool-definition)
  — AgentDojo's threat model is indirect injection via tool results, which is
  exactly the surface to test, but note the scope.
- **`block` vs `warn`.** Default counts only a hard `block` as a defense action
  (mirrors the proxy). `--block-on-warn` is a more aggressive operating point
  that will lower ASR and likely lower utility too.
