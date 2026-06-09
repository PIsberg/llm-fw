# Detection Scorecard

Deterministic full sweep over the labelled corpus (92 attacks, 60 benign prompts incl. security-themed hard negatives) through the real proxy.
Cheap stages only — **heuristic + embedding, judge off**; enabling the local Ollama judge raises recall further on novel phrasings.

| Attack class | Detected | Recall |
|---|---|---|
| delimiter-confusion | 6/6 | 100% |
| direct-override | 8/8 | 100% |
| exfiltration-markdown | 6/6 | 100% |
| indirect-injection | 8/8 | 100% |
| multilingual | 10/10 | 100% |
| obfuscation-encoding | 10/10 | 100% |
| payload-splitting | 8/8 | 100% |
| persona-jailbreak | 10/10 | 100% |
| prompt-exfil | 8/8 | 100% |
| roleplay-fiction | 10/10 | 100% |
| social-engineering | 8/8 | 100% |
| **Overall (TPR)** | **92/92** | **100.0%** (gate ≥ 70%) |
| **False positives (FPR)** | **1/60** | **1.7%** (gate ≤ 2%) |

Latency through the full pipeline: p50 61 ms · p95 171 ms. Generated 2026-06-09 by `npm run scorecard` (gate: PASSED).
