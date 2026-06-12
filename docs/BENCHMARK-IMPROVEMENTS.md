# Benchmark improvements — before / after

Tracks detector work aimed at closing the two gaps Phase 1 measured: indirect
injection (InjecAgent) and harmful-content requests (JBB/HarmBench/AdvBench).
All numbers are the **cheap** preset (heuristic + embedding + the new
deterministic detectors — no classifier, no Ollama judge), full splits, so the
gains are free at runtime. FPR is the hard constraint: the load-corpus scorecard
gate (0 FP on 68 benign) and the injection sets' benign rows must not regress.

Reproduce:

```
node --import tsx/esm scripts/run-benchmark.ts cheap --json
npm run scorecard         # must stay 100% / 0 FP
```

## Before (Phase 1 baseline, cheap preset, full splits)

| Dataset | Threat | n | Recall | FPR |
|---|---|---|---|---|
| gandalf | injection | 112 | 85.7% | — |
| safeguard | injection | 2,060 | 43.7% | 0.6% |
| deepset | injection | 116 | 16.7% | 0.0% |
| heldout | injection | 52 | 45.2% | 14.3% |
| **injecagent** | indirect-injection | 1,071 | **0.0%** | 0.0% |
| **jbb-behaviors** | harmful-content | 200 | **3.0%** | 1.0% |
| **harmbench** | harmful-content | 400 | **2.2%** | — |
| **advbench** | harmful-content | 520 | **4.2%** | — |

Scorecard (load corpus, default config): 100% recall / 0% FPR.

## After (two new deterministic detectors, cheap preset, full splits)

Added two cheap, deterministic detection stages (no model, no Ollama):

1. **Indirect-instruction** (`src/detection/indirectInstruction.ts`) — runs only
   on the `tool_result` / `document` surfaces and flags an imperative
   action-instruction planted in data (the InjecAgent threat model: "Please
   grant access to guest_amy01", "forward this to attacker@evil.com"). A tool
   result is supposed to be passive data, so a second-person imperative to a
   sensitive side-effecting action has no legitimate origin there. On by default
   in block mode.
2. **Harmful-request** (`src/detection/harmfulRequest.ts`) — runs on the user
   prompt and flags requests for operationally harmful content (weapon/drug
   synthesis how-tos, intrusion/fraud, hateful/defamatory production). Tightly
   precision-gated: defensive/educational framing, data-transform-over-provided-
   content, and non-operational fiction are all suppressed, so security Q&A
   ("Explain how SQL injection works") passes. On by default in block mode;
   disable with `LLM_FW_HARMFUL_REQUEST_ENABLED=false` for a pure injection
   firewall.

| Dataset | Threat | n | Recall before → after | FPR before → after |
|---|---|---|---|---|
| gandalf | injection | 112 | 85.7% → 85.7% | — |
| safeguard | injection | 2,060 | 43.7% → **45.4%** | 0.6% → 0.6% |
| deepset | injection | 116 | 16.7% → 16.7% | 0.0% → 0.0% |
| heldout | injection | 52 | 45.2% → 45.2% | 14.3% → 14.3% |
| **injecagent** | indirect-injection | 1,071 | 0.0% → **95.2%** | 0.0% → 0.0% |
| **jbb-behaviors** | harmful-content | 200 | 3.0% → **26.0%** | 1.0% → 2.0% |
| **harmbench** | harmful-content | 400 | 2.2% → **18.2%** | — |
| **advbench** | harmful-content | 520 | 4.2% → **40.4%** | — |

Scorecard (load corpus, default config): **100% recall / 0% FPR — unchanged.**

### Notes

- **Indirect injection is the headline: 0% → 95.2% recall at 0% FPR.** The cheap
  stages were completely blind to instructions planted in tool output; the new
  surface-scoped detector closes almost all of it. The benign side (17 synthetic
  tool responses) stays at 0 false positives after excluding JSON field names
  (`'email':`, `'cc':`) and terminal one-word values from the imperative match.
- **Harmful-content recall rises 5–10× (2–4% → 18–40%)** with the deterministic
  rules alone — and the residual gap is the honest argument for a trained
  moderation classifier (PLAN-future Phase 5). Keyword rules catch the explicit
  asks; they will never catch the long tail of euphemism, and chasing it with
  more regex would overfit. These numbers are the floor a learned layer should
  beat, not a ceiling.
- **No regression on the injection sets.** gandalf/deepset/heldout are
  unchanged; safeguard recall even ticks up (the harmful-request rule also
  catches a few injection-labelled rows) with FPR flat at 0.6%. The injection
  firewall's calibration is untouched — these are additive stages.
- **The new false positives are concentrated and expected.** jbb FPR 1%→2% is a
  single extra benign row of 100 (the JailbreakBench benign set is built as
  near-paraphrases of the harmful prompts, so it is the worst case for any
  content rule). The representative benign sets (safeguard 1,410 rows, deepset,
  heldout, the 68-prompt scorecard corpus) show **zero** new false positives.
