# plan: future improvements

Forward-looking roadmap derived from the held-out benchmark
([docs/BENCHMARK.md](../BENCHMARK.md)). The benchmark established three things:

1. On its core threat — direct instruction-override — the firewall is excellent
   (gandalf 85.7% cheap → **100%** with the classifier).
2. The trained ONNX classifier is the right generalization layer: it lifts recall
   on every independent set (deepset 17→45%, safeguard 50→78%, heldout 45→77%)
   while holding FPR low on representative traffic (0–1.7%).
3. The small generative judge is **not** a usable general backstop (27–86% FPR);
   prompt-tuning it was tried and measured no improvement.

The gap between "strong, measured prompt-injection firewall" and a defensible
"state of the art" claim is now small and known. This plan closes it.

---

## Phase 1 — Broaden the benchmark to the full public suite

**Why:** current sets measure prompt *injection* on sampled subsets. A credible
claim needs larger, standard, and *threat-diverse* benchmarks.

- Add harmful-content / jailbreak sets (a DIFFERENT threat model than injection —
  report them separately, do not average): **JailbreakBench** (JBB-Behaviors),
  **HarmBench**, **AdvBench**. These test whether a jailbroken *request* is
  caught, which is the judge/classifier's job, not the override heuristics'.
- Add an indirect-injection agent benchmark: **InjecAgent** (tool-result
  poisoning) — exercises the `tool_result` / RAG surfaces, not just user prompts.
- Add the **PINT** benchmark (Lakera) if accessible.
- Stop sampling: run full splits where size allows; record exact N and dataset
  revision in `docs/BENCHMARK.md` for reproducibility.
- Harness work: `scripts/run-benchmark.ts` already auto-loads `test/eval/data/*`;
  add a `--json` output mode and a per-class breakdown so regressions are visible
  per attack family.

**Done when:** `docs/BENCHMARK.md` reports recall/FPR for ≥3 independent injection
sets and ≥2 harmful-content sets, with N and source revisions pinned.

**Status (2026-06-12): DONE.** `scripts/fetch-eval-data.ts` reproducibly fetches
all public sets with pinned revisions; suite is now 4,531 rows across 4 injection
sets (safeguard expanded to its full 2,060-row split), InjecAgent (1,071 rows on
the `tool_result` surface), and JBB/HarmBench/AdvBench (reported separately).
PINT is request-only (part-proprietary) and excluded. Harness has `--json`,
`--only=`, and per-attack-class breakdowns. Key new numbers: safeguard full split
43.7→84.2% recall at 0.6→0.7% FPR (classifier); InjecAgent 0% cheap / 52% classifier
(the biggest measured gap → Phases 3–5); harmful-content 2–4% with or without the
classifier, confirming it needs a content-moderation layer (Phase 5).

---

## Phase 2 — Head-to-head against other guardrails

**Why:** "state of the art" is a *relative* claim; it requires comparison.

- Benchmark, on the same datasets, against: **Llama Guard 3 / Prompt Guard**
  (Meta), **Lakera Guard** (API), **protectai/deberta** standalone, **Rebuff**,
  **Vigil**, **NeMo Guardrails**.
- Report the precision/recall frontier (a scatter of recall vs FPR per system),
  not a single number — the honest way to show where llm-fw sits.
- Note the architectural axis competitors don't have: llm-fw is a single
  network chokepoint covering *every* tool on a machine, including
  un-instrumentable ones. Capability ≠ benchmark score; document both.

**Done when:** a comparison table + frontier plot lands in `docs/BENCHMARK.md`.

---

## Phase 3 — Push recall on novel / semantic-only attacks

**Why:** the classifier still misses the hardest heldout cases (creative persona
jailbreaks, dual-use semantic asks): heldout recall 77%.

- **Ensemble the learned signals:** combine the DeBERTa classifier score with the
  embedding similarity and heuristic score via a small calibrated rule (or a
  logistic blend) rather than independent thresholds — catches cases each misses
  alone.
- **Evaluate a stronger / newer classifier:** test newer prompt-injection models
  (e.g. updated Prompt Guard, larger DeBERTa, or a distilled fine-tune) on the
  benchmark; swap if it Pareto-dominates at equal FPR.
- **Multilingual classifier coverage:** the current classifier is English-centric;
  measure non-English recall and add a multilingual injection classifier or keep
  the embedding stage as the cross-lingual path (already strong there).
- **Two-tier policy:** classifier-block at high confidence (≥0.9), classifier-warn
  in a 0.5–0.9 band that *then* escalates to the judge — uses the judge only where
  it adds signal, sidestepping its blanket-FP problem.

**Done when:** heldout recall ≥90% with no regression in safeguard FPR (≤2%).

---

## Phase 4 — Reduce injection-adjacent-benign false positives

**Why:** the residual FP is concentrated in benign text that *looks* like
injection ("translate 'disregard the previous draft'", "summarize a heist movie
where the crew bypasses the alarm"). Same irreducible class the embedding stage
hits.

- **Intent vs mention:** distinguish a prompt that *issues* an override from one
  that *quotes/translates/summarizes* one. A lightweight signal: is the injection
  phrase inside quotes / a translation request / a clearly-fictional frame?
- **Calibrate thresholds per surface:** a `tool_result` (untrusted data) warrants
  a lower bar than a top-level user prompt; expose per-source thresholds.
- **Operator feedback loop:** the dashboard already has a whitelist; feed
  whitelisted false-positives back as negative exemplars for threshold tuning and
  surface an FPR estimate from real traffic.

**Done when:** heldout FPR ≤10% without losing recall on gandalf/safeguard.

---

## Phase 5 — Output-side and agentic depth

**Why:** input detection is necessarily imperfect; defense-in-depth on the output
and the agent loop raises the floor.

- Upgrade the audit-only response-harm scan toward a trained output classifier
  (Llama-Guard-style) so harmful *completions* are flagged with calibrated
  precision, optionally block-capable.
- Strengthen indirect-injection coverage measured by InjecAgent (Phase 1): ensure
  the classifier runs on `tool_result` content, not just prompts (it already
  does via the scan-item loop — add explicit benchmark coverage).
- Cross-turn crescendo: extend beyond the in-request heuristic to an optional
  session-state signal for proxies that see a stable client identity.

**Done when:** an output-side benchmark exists and indirect-injection recall is
reported separately.

---

## Non-goals / explicit limits

- Not a harmful-content moderation product first; it is a prompt-injection
  firewall. Harmful-content metrics are reported but secondary.
- The generative Ollama judge stays opt-in and suspicious-only; `judgeUnlessBenign`
  remains documented as not recommended (measured 27–86% FPR).
- No claim of "stops all attacks" — the benchmark is the honesty contract; every
  capability claim must cite a held-out number.
