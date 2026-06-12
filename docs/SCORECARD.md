# Detection Scorecard

Deterministic full sweep over the labelled corpus (110 attacks, 68 benign prompts incl. security-themed hard negatives) through the real proxy.
Cheap stages only — **heuristic + embedding, judge off**; enabling the local Ollama judge raises recall further on novel phrasings.

| Attack class | Detected | Recall |
|---|---|---|
| delimiter-confusion | 6/6 | 100% |
| direct-override | 8/8 | 100% |
| exfiltration-markdown | 6/6 | 100% |
| indirect-injection | 8/8 | 100% |
| many-shot | 2/2 | 100% |
| multilingual | 10/10 | 100% |
| obfuscation-encoding | 12/12 | 100% |
| payload-splitting | 8/8 | 100% |
| persona-jailbreak | 10/10 | 100% |
| policy-puppetry | 3/3 | 100% |
| prefix-injection | 4/4 | 100% |
| prompt-exfil | 8/8 | 100% |
| refusal-override | 4/4 | 100% |
| roleplay-fiction | 10/10 | 100% |
| skeleton-key | 3/3 | 100% |
| social-engineering | 8/8 | 100% |
| **Overall (TPR)** | **110/110** | **100.0%** (gate ≥ 70%) |
| **False positives (FPR)** | **0/68** | **0.0%** (gate ≤ 2%) |

Latency through the full pipeline: p50 218 ms · p95 765 ms. Generated 2026-06-12 by `npm run scorecard` (gate: PASSED).
