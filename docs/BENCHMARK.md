# Generalization Benchmark

The [Detection Scorecard](SCORECARD.md) reports 100% recall / 0% FPR — but that
corpus was **authored and tuned alongside the detectors**, so it is a regression
gate, *not* evidence of generalization. This document reports the honest picture:
how the firewall performs on attacks it was **never tuned on**.

## Method

`scripts/run-benchmark.ts` runs the **real** detection pipeline over two held-out
datasets and reports recall (attacks blocked) and false-positive rate (benign
blocked):

Datasets (`test/eval/data/`; the harness auto-loads every labelled `*.json`):

- **gandalf-ignore-instructions** — `Lakera/gandalf_ignore_instructions` test
  split (112 rows), real injection attempts from the Gandalf challenge.
  Attacks-only → recall-only.
- **safeguard-prompt-injection** — `xTRam1/safe-guard-prompt-injection` test
  split, balanced 60 injection / 60 benign. A clean independent binary set.
- **deepset** — `deepset/prompt-injections` test split (116 rows). Labels are
  noisy: it marks benign role-play ("act as an interviewer") and many short
  topic fragments as injections, which *depresses* measured recall for a firewall
  whose threat model treats benign role-play as safe.
- **heldout** — 52 self-authored novel phrasings, deliberately *not* drawn from
  the tuning corpus. The hardest set on purpose: semantic-only jailbreaks (no
  keyword signature) and injection-adjacent benign hard-negatives.

```
node --import tsx/esm scripts/run-benchmark.ts <preset> [ollama-model]
# presets: cheap | judge-suspicious | judge-unless | classifier
```

## Results

Recall = attacks blocked; FPR = benign blocked. Higher recall **and** lower FPR
is better. Per-dataset recall / FPR:

| Dataset | Cheap (default) | + Trained classifier |
|---|---|---|
| gandalf (real "ignore instructions" attacks) | 85.7% / — | **100% / —** |
| safeguard (clean, balanced) | 50.0% / 1.7% | **78.3% / 1.7%** |
| deepset (noisy labels) | 16.7% / 0% | 45.0% / 0% |
| heldout (hardest, adversarial benign) | 45.2% / 14.3% | 77.4% / 23.8% |

The generative judge, measured on deepset + heldout (qwen2.5:3b), as a contrast:

| Configuration | deepset recall / FPR | heldout recall / FPR |
|---|---|---|
| + judge, suspicious-only | 70% / 27% | 87% / 57% |
| + judge, judge-unless-benign | 93% / 48% | 100% / 86% |
| + judge, judge-unless-benign (phi3) | — | 100% / 83% |

## What this means

1. **On its home turf — direct instruction-override attacks — it is excellent.**
   Gandalf's real "ignore your instructions" attempts: 85.7% caught by the cheap
   stages alone, **100% with the classifier**.

2. **The trained classifier is the right generalization layer.** Across every set
   it lifts recall substantially (gandalf 86→100%, safeguard 50→78%, deepset
   17→45%, heldout 45→77%) while keeping false positives **low on representative
   traffic** (0–1.7% on the clean independent sets). It runs locally (ONNX,
   ~150–270 ms CPU), needs no Ollama, and is the recommended upgrade. Enable it
   with `detection.classifier.enabled` (or the Settings tab). Its higher 24% FPR
   appears only on the *heldout* set, which is stacked with injection-adjacent
   benign hard-negatives ("translate 'disregard the previous draft'") — the same
   irreducible class the embedding stage hits; the safeguard set (1.7% FPR on 60
   ordinary benign prompts) is the more representative number.

3. **The deterministic stages alone are precise but miss novel phrasings** —
   17–50% recall on the independent binary sets. That is what regex +
   embedding-similarity can do, and no more.

4. **A small generative judge is NOT a usable general backstop.** Asked to
   classify every prompt, qwen2.5:3b and phi3 block **27–86%** of *benign*
   traffic. Prompt-tuning it (precision guidance + few-shot) was tried and
   measured no improvement. Keep `judgeUnlessBenign` **off**; the judge is useful
   only in its default suspicious-only escalation, and even there it trades
   precision for recall.

## Honest bounds

These numbers are directional (sampled subsets; deepset's labels are imperfect),
not a certified benchmark, and they measure prompt **injection**, not harmful-
content jailbreaks (a different threat model — HarmBench/JailbreakBench would test
that separately). A fuller claim would add those sets and a head-to-head against
other guardrails (Llama Guard, Lakera). The takeaway that *is* solid: **across
four independent datasets, the trained classifier lifts recall substantially —
to 100% on real instruction-override attacks — while keeping false positives low
on representative traffic; the generative judge does not.**
