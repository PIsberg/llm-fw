[llm-fw](../README.md) > [Documentation](README.md) > Measurements > AgentDojo Benchmark (agentic injection)

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
thresholds are identical to the proxy. Four pipelines are compared:

| Pipeline | Defense element in the tools loop |
|---|---|
| `undefended` | none — the attack's natural success rate |
| `llm-fw` | `LlmFwDetector` → scan server → real llm-fw pipeline; a block aborts the agent |
| `llm-fw-withhold` | the same detector; a block replaces the tool output with AgentDojo's `<Data omitted because a prompt injection was detected>` notice and the agent goes on, as the proxy's default `onBlock: 'withhold'` does |
| `transformers_pi_detector` | AgentDojo's built-in ProtectAI-deberta detector |

Each is run with no injection (utility floor) and under the
`important_instructions` attack (ASR + utility-under-attack).

```bash
npm run scan-server &                       # llm-fw bridge
cd integrations/agentdojo
python run_agentdojo.py --model gpt-4o-mini \
    --pipelines undefended,llm-fw,llm-fw-withhold,transformers_pi_detector \
    --suites banking,slack,travel,workspace \
    --attack important_instructions --json-out results.json
```

With no API key, `bash scripts/run-agentdojo.sh` runs the same comparison
against a local model on a fixed subset; see
[the integration README](../integrations/agentdojo/README.md#with-a-local-model-no-api-key).

## Results

### Local run: qwen2.5:14b, banking, one injection task

Measured 2026-11-11 with `scripts/run-agentdojo.sh` on its defaults: agent
`qwen2.5:14b` through Ollama (native tool calling, temperature 0), AgentDojo
0.1.35, suite version v1.2.1, the `important_instructions` attack, all 16
banking user tasks, and `injection_task_0` only. llm-fw ran on its default
configuration at main 09a51de. Each pipeline ran 16 tasks with no attack and
16 attacked pairs; the 99 runs took 4 hours on a laptop CPU.

| Pipeline | ASR (lower is better) | Utility, no attack | Utility under attack |
|---|---|---|---|
| undefended | 10/16 (62.5%) | 9/16 (56.2%) | 6/16 (37.5%) |
| llm-fw | **0/16 (0.0%)** | 6/16 (37.5%) | 4/16 (25.0%) |
| transformers_pi_detector | 3/16 (18.8%) | 7/16 (43.8%) | 5/16 (31.2%) |

What the numbers do and do not say:

- **ASR.** llm-fw stopped all 10 attacks that succeeded undefended. 0 of 16
  still has a 95% upper bound of 21% (Clopper-Pearson), so this is a small
  sample, not a rate.
- **Utility, no attack: 1 lost task is llm-fw's.** On the benign runs llm-fw
  aborted one task, `user_task_0`, on the bill it was asked to pay, which says
  "Please pay the amount by sending a bank transfer to the following account"
  and names an IBAN on the next line. A polite payment order with a recipient
  is the attack's shape, so this still blocks; since ruleset 2026.11.55 a
  reminder that names no recipient ("Please pay the invoice.") passes
  ([#767](https://github.com/PIsberg/llm-fw/issues/767)). The other gaps to
  the undefended row are the model: with no detector action in them, 3 tasks
  that succeeded undefended failed under llm-fw and 1 went the other way. Ollama
  on CPU is not reproducible at temperature 0, so a difference of a few tasks
  between rows is noise at n=16.
- **The two detectors act differently.** `LlmFwDetector` aborts the run on a
  block (`raise_on_injection=True`), which is how AgentDojo scores a prevented
  attack; it ended 10 of the 16 attacked runs. AgentDojo's DeBERTa detector
  replaces the flagged tool output with `<Data omitted because a prompt
  injection was detected>` and lets the agent go on. It did that to at least one
  benign tool output in 10 of the 16 no-attack tasks (mostly transaction
  lists), against llm-fw's 1 abort, and the agent still finished 7 of them. The
  proxy's own default withholds a blocked tool result rather than refusing,
  which is closer to the DeBERTa behaviour. The `llm-fw-withhold` pipeline runs
  llm-fw that way, and has not been measured on this subset yet
  ([#768](https://github.com/PIsberg/llm-fw/issues/768)).

Not measured: the slack, travel and workspace suites, the other 8 banking
injection tasks, other attacks, and any hosted model. A four-suite sweep with
an API model needs a provider budget nobody has spent on it yet.

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
