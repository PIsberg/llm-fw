# Generalization Benchmark

The [Detection Scorecard](SCORECARD.md) reports 100% recall / 0% FPR — but that
corpus was **authored and tuned alongside the detectors**, so it is a regression
gate, *not* evidence of generalization. This document reports the honest picture:
how the firewall performs on attacks it was **never tuned on**.

## Method

`scripts/run-benchmark.ts` runs the **real** detection pipeline over two held-out
datasets and reports recall (attacks blocked) and false-positive rate (benign
blocked):

- **deepset** — the `deepset/prompt-injections` test split (116 rows), an
  independent public reference. Note its labels are noisy: it marks benign
  role-play ("act as an interviewer") and many short topic fragments as
  injections, which depresses measured recall for a firewall whose threat model
  treats benign role-play as safe.
- **heldout** — 52 self-authored novel phrasings (`test/eval/data/heldout.json`),
  deliberately *not* drawn from the tuning corpus. Harder than deepset; includes
  semantic-only jailbreaks (no keyword signature) and injection-adjacent benign
  hard-negatives.

```
node --import tsx/esm scripts/run-benchmark.ts <preset> [ollama-model]
# presets: cheap | judge-suspicious | judge-unless | classifier
```

## Results

Recall = attacks blocked; FPR = benign blocked. Higher recall **and** lower FPR
is better.

| Configuration | deepset recall | deepset FPR | heldout recall | heldout FPR |
|---|---|---|---|---|
| Cheap stages (heuristic + embedding, **default**) | 16.7% | **0%** | 45% | 14% |
| **+ Trained classifier** (opt-in) | **45%** | **0%** | **77%** | 24% |
| + Generative judge, suspicious-only (qwen2.5:3b) | 70% | 27% | 87% | 57% |
| + Generative judge, judge-unless-benign (qwen2.5:3b) | 93% | 48% | 100% | 86% |
| + Generative judge, judge-unless-benign (phi3) | — | — | 100% | 83% |

## What this means

1. **The deterministic stages are precise but miss novel phrasings.** ~17–45%
   recall on attacks they weren't tuned for, with near-zero false positives. That
   is what regex + embedding-similarity can do, and no more.

2. **The trained classifier is the right generalization layer.** It roughly
   **doubles** cheap-stage recall and adds **zero** false positives on the
   independent public set. It runs locally (ONNX, ~150–270 ms CPU), needs no
   Ollama, and is the recommended upgrade for novel-attack coverage. Enable it
   with `detection.classifier.enabled` (or the Settings tab). Its residual
   heldout false positives are injection-adjacent benign ("translate 'disregard
   the previous draft'") — the same irreducible class the embedding stage hits.

3. **A small generative judge is NOT a usable general backstop.** Asked to
   classify every prompt, qwen2.5:3b and phi3 block **27–86%** of *benign*
   traffic. Prompt-tuning it (precision guidance + few-shot) was tried and
   measured no improvement. Keep `judgeUnlessBenign` **off**; the judge is useful
   only in its default suspicious-only escalation, and even there it trades
   precision for recall.

## Honest bounds

These numbers are directional (small N, and deepset's labels are imperfect), not
a certified benchmark. A rigorous claim would add larger public sets
(JailbreakBench, HarmBench, InjecAgent) and head-to-head comparison with other
guardrails. The takeaway that *is* solid: **with the trained classifier enabled,
the firewall meaningfully generalizes beyond its tuning corpus while keeping
false positives low; the generative judge does not.**
