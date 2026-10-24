# Rule: detection

Read when touching anything under `src/detection/`, a threshold, or the corpus.

## The accuracy gate

`test/detection/accuracy.eval.test.ts` runs the cheap pipeline (heuristic plus
embedding, judge off) against `test/detection/fixtures/corpus.json` and asserts
precision >= 95%, overall recall >= 80%, and per-attack-category recall >= 60%.
It is part of `npm run test:run`, so it already gates every PR.

**Grow the corpus, not the thresholds.** If your change fixes a miss, add the
example that exposed it to `corpus.json` rather than only fixing the one case
you hit. If a threshold itself genuinely needs to move, say so explicitly in the
PR with the measured before and after. Never lower one silently to go green.

## The three stages

1. **Heuristic** (`src/detection/heuristic.ts`) plus multi-candidate
   normalization. Cheap, deterministic, runs on every request.
2. **Embedding similarity** (`src/detection/embedding.ts`), model
   `Xenova/multilingual-e5-small`, loaded eagerly by `llm-fw start` before any
   listener binds, then resident for the process lifetime. The cosine
   gate is calibrated; changing it invalidates published benchmark numbers.
3. **Judge LLM** via Ollama (`src/detection/judge.ts`). Off by default,
   asynchronous by default, and never fatal: a failed call returns `ERROR` and
   the pipeline continues.

Prefer closing a miss additively in stage 1 over recalibrating stage 2. A regex
gap is a local fix; a threshold move is a global one.

## Linear time

Detection runs on the thread that serves every request, and its input is
often attacker-controlled, so a regex with quadratic worst case stalls every
client. Two shapes did (GHSA-gm3q-2gwx-gppq): a leading `\b` or `\s*` before a
character class that can span a long run (`\b[A-Za-z0-9._%+-]+@`,
`[.!?\n]\s*`, `[,;]?\s*`), which restarts at every position of the run and
rescans it. Start such a pattern where the previous character cannot belong
to the run (`(?<![...])`), and skip only horizontal whitespace after a line
break. New detectors get a timing test on 200 KB of whitespace, `1-` and
base64url, like those in `test/detection/indirectInstruction.test.ts`.

## Ruleset version

Detection carries `RULESET_VERSION` in `src/detection/ruleset.ts`, separate from
the npm version, because a patch release can move a threshold and a feature
release can leave detection untouched. A CI gate hashes every file that can
change a verdict and fails until the version is cut. If you changed a verdict,
expect that gate to demand a bump.

Do not repeat the current ruleset value in prose anywhere. It goes stale.

## After a detection change

- `npm run scorecard` regenerates the numbers behind
  [docs/SCORECARD.md](../../docs/SCORECARD.md) and the README's scorecard
  section. Run it and update both if accuracy measurably shifted.
- `npm run fpr` runs the false-positive evaluation.
- `npm run verdicts:dump -- before.json` on the old tree, the same with
  `after.json` on the new one, then `npm run verdicts:diff -- before.json
  after.json`: the row-by-row "N of 23,938 eval verdicts changed" a ruleset or
  dependency PR should quote. Aggregates can hold while rows trade places.
- `npm run bench:competitors` compares against third-party guardrails on the
  same held-out splits. Useful context for a detection PR, not required.

Numbers over adjectives in the PR body: give the measured before and after, not
"improved".
