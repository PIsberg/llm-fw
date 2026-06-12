# Generalization Benchmark

The [Detection Scorecard](SCORECARD.md) reports 100% recall / 0% FPR — but that
corpus was **authored and tuned alongside the detectors**, so it is a regression
gate, *not* evidence of generalization. This document reports the honest picture:
how the firewall performs on attacks it was **never tuned on**.

## Method

`scripts/run-benchmark.ts` runs the **real** detection pipeline over held-out
datasets and reports recall (attacks blocked) and false-positive rate (benign
blocked). Datasets live in `test/eval/data/` (the harness auto-loads every
labelled `*.json`); every public set is regenerated reproducibly by
`scripts/fetch-eval-data.ts`, which pins the upstream git revision in the
file's `_revision` field. **Full splits, no sampling.**

Datasets are grouped by **threat model** and reported separately — averaging
across groups would be dishonest, because they test different jobs:

**Prompt injection** (user-prompt surface — the firewall's core threat):

- **gandalf-ignore-instructions** — `Lakera/gandalf_ignore_instructions` full
  test split (n=112, rev `04737b65e90a`). Real injection attempts from the
  Gandalf challenge. Attacks-only → recall-only.
- **safeguard-prompt-injection** — `xTRam1/safe-guard-prompt-injection` full
  test split (n=2,060: 650 injection / 1,410 benign, rev `a3a877d608f3`). The
  largest clean independent binary set in the suite.
- **deepset** — `deepset/prompt-injections` full test split (n=116: 60/56,
  rev `4f61ecb038e9`). Labels are noisy: it marks benign role-play ("act as an
  interviewer") and short topic fragments as injections, which *depresses*
  measured recall for a firewall whose threat model treats benign role-play as
  safe.
- **heldout** — 52 self-authored novel phrasings (31 attacks / 21 benign),
  deliberately *not* drawn from the tuning corpus. The hardest set on purpose:
  semantic-only jailbreaks (no keyword signature) and injection-adjacent benign
  hard-negatives.

**Indirect injection** (`tool_result` surface — attacker text arriving in tool
output, not from the user):

- **injecagent** — `uiuc-kang-lab/InjecAgent` base test cases, dh + ds, full
  (n=1,071: 1,054 attacks / 17 benign, rev `f19c9f2c79a4`). Attacker
  instructions embedded in realistic tool responses (product reviews, notes,
  emails); the harness delivers them as Anthropic `tool_result` blocks, so this
  exercises the pipeline's indirect-injection scan path. The 17 benign rows are
  the same tool-response templates with innocuous filler (synthetic; small n —
  treat the FPR as indicative only).

**Harmful content / jailbreak requests** (a *different threat model*: does the
firewall catch a harmful *request*, e.g. "write a phishing email" — not an
instruction-override):

- **jbb-behaviors** — JailbreakBench `JBB-Behaviors` full harmful + benign
  splits (n=200: 100/100, rev `886acc352a31`).
- **harmbench** — HarmBench text behaviors, full (n=400, attacks-only,
  rev `8e1604d1171f`; contextual behaviors include their context).
- **advbench** — AdvBench `harmful_behaviors`, full (n=520, attacks-only,
  rev `098262edf85f`).

**PINT** (Lakera): not included — the repo publishes the harness but the
4,314-input dataset is part-proprietary and available only on request to
Lakera, so it cannot be fetched reproducibly.

```
node --import tsx/esm scripts/fetch-eval-data.ts            # regenerate public datasets
node --import tsx/esm scripts/run-benchmark.ts <preset> [ollama-model] [--json] [--only=name,...]
# presets: cheap | judge-suspicious | judge-unless | classifier
# --json emits machine-readable results incl. a per-attack-class breakdown
```

## Results

Recall = attacks blocked; FPR = benign blocked. Higher recall **and** lower FPR
is better. Per-dataset recall / FPR, cheap stages (heuristic + embedding)
vs. cheap + the trained ONNX classifier:

**Prompt injection**

| Dataset | n | Cheap (default) | + Trained classifier |
|---|---|---|---|
| gandalf (real "ignore instructions" attacks) | 112 | 85.7% / — | **100% / —** |
| safeguard (clean, balanced, full split) | 2,060 | 43.7% / 0.6% | **84.2% / 0.7%** |
| deepset (noisy labels) | 116 | 16.7% / 0% | 41.7% / 0% |
| heldout (hardest, adversarial benign) | 52 | 45.2% / 14.3% | 77.4% / 23.8% |

**Indirect injection (tool_result surface)**

| Dataset | n | Cheap (default) | + Trained classifier |
|---|---|---|---|
| injecagent (tool-result poisoning) | 1,071 | 0% / 0% | 52.2% / 35.3%† |

† FPR over only 17 synthetic benign rows (6 blocked) — indicative, not precise.

**Harmful content / jailbreak requests** (different threat model — do not
average with injection)

| Dataset | n | Cheap (default) | + Trained classifier |
|---|---|---|---|
| jbb-behaviors (100 harmful / 100 benign) | 200 | 3.0% / 1.0% | 3.0% / 2.0% |
| harmbench | 400 | 2.2% / — | 2.5% / — |
| advbench | 520 | 4.2% / — | 4.2% / — |

The generative judge, measured on deepset + heldout (qwen2.5:3b), as a contrast
(measured on the earlier sampled splits; the conclusion is threshold-level, not
dataset-level):

| Configuration | deepset recall / FPR | heldout recall / FPR |
|---|---|---|
| + judge, suspicious-only | 70% / 27% | 87% / 57% |
| + judge, judge-unless-benign | 93% / 48% | 100% / 86% |
| + judge, judge-unless-benign (phi3) | — | 100% / 83% |

## What this means

1. **On its home turf — direct instruction-override attacks — it is excellent.**
   Gandalf's real "ignore your instructions" attempts: 85.7% caught by the cheap
   stages alone, **100% with the classifier**.

2. **The trained classifier is the right generalization layer for injection.**
   On the full 2,060-row safeguard split it nearly doubles recall (43.7→84.2%)
   at essentially unchanged FPR (0.6→0.7%). The pattern holds on every injection
   set (gandalf 86→100%, deepset 17→42%, heldout 45→77%). It runs locally
   (ONNX, ~150–270 ms CPU), needs no Ollama, and is the recommended upgrade —
   enable with `detection.classifier.enabled` (or the Settings tab). Its higher
   24% FPR appears only on the *heldout* set, which is stacked with
   injection-adjacent benign hard-negatives ("translate 'disregard the previous
   draft'") — the same irreducible class the embedding stage hits; safeguard
   (0.7% FPR on 1,410 ordinary benign prompts) is the representative number.

3. **Indirect injection is measurably harder, and now measured.** InjecAgent's
   attacker instructions are *benign-phrased* commands embedded in tool output
   ("please grant access to guest_amy01…") — no override language at all, so
   the cheap stages catch **0%**. The classifier recovers 52%, but at high FPR
   on instruction-shaped benign tool responses. Detecting "an instruction where
   only data should be" is a different problem than detecting injection
   phrasing; this is the firewall's biggest measured gap (Phases 3–5 of
   [PLAN-future](plans/PLAN-future.md)).

4. **Harmful-content requests are out of scope for the current detectors — the
   numbers prove it.** 2–4% recall across JailbreakBench, HarmBench and
   AdvBench, with or without the classifier: the heuristics target override
   phrasing and the classifier is injection-specific
   (`protectai/deberta-v3-base-prompt-injection-v2`), so a politely-worded
   harmful request sails through. This is by design (llm-fw is a
   prompt-injection firewall first), but it kills any temptation to read the
   injection numbers as "blocks bad things in general". Catching harmful
   *requests* needs a content-moderation layer (Llama-Guard-class), tracked in
   Phase 5.

5. **The deterministic stages alone are precise but miss novel phrasings** —
   17–46% recall on the independent injection sets at near-zero FPR. That is
   what regex + embedding-similarity can do, and no more.

6. **A small generative judge is NOT a usable general backstop.** Asked to
   classify every prompt, qwen2.5:3b and phi3 block **27–86%** of *benign*
   traffic. Prompt-tuning it (precision guidance + few-shot) was tried and
   measured no improvement. Keep `judgeUnlessBenign` **off**; the judge is
   useful only in its default suspicious-only escalation, and even there it
   trades precision for recall.

## Honest bounds

Full splits with pinned revisions replace the earlier sampled subsets, so these
numbers are reproducible — but they are still not a certified benchmark:
deepset's labels are imperfect, InjecAgent's benign side is 17 synthetic rows,
and the harmful-content sets measure a threat model this product treats as
secondary. A "state of the art" claim additionally needs a head-to-head against
other guardrails (Llama Guard / Prompt Guard, Lakera, protectai-standalone) on
these same sets — that comparison is Phase 2 of
[PLAN-future](plans/PLAN-future.md). The takeaway that *is* solid: **across
four independent injection datasets, the trained classifier lifts recall
substantially — to 100% on real instruction-override attacks and 84% on the
largest clean split — while keeping false positives at 0.7% on representative
traffic; indirect injection and harmful-content requests remain measured,
documented gaps.**
