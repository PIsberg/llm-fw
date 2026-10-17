# Quickstart: hand-run checks for the Tool Result Shunt

Automated tests cover behaviour (tasks.md). These checks need a person, a local model or money.

## 1. Replay stage (free; US5-1, US5-2, US5-5; SC-001, SC-002, SC-003, SC-010)

Prerequisites: a worker on this machine serving the OpenAI-compatible chat API, for example
`ollama pull qwen2.5:3b` and `ollama serve`; recorded Claude Code sessions under
`~/.claude/projects`.

```bash
npm run eval:shunt:replay -- --sessions ~/.claude/projects --max-sessions 200 \
  --worker-url http://127.0.0.1:11434 --worker-model qwen2.5:3b --out "$SCRATCH/replay-1.json"
```

Expected: the report holds every figure of US5-1 twice (file reads excluded, file reads
included), names the tokenizer (`Xenova/gpt-4o`), the worker model, the sample size and the
date, and the labelled-subset size (D6). Run it a second time to `replay-2.json`: results seen,
results eligible and original tokens match exactly (US5-2). `~/.llm-fw` is unchanged: compare a
listing before and after (US5-5). Raise `--max-sessions` until the labelled subset reaches 50
(SC-002).

## 2. Comparison stage (billed; only after the maintainer approves the spend, D7)

```bash
npm run eval:shunt:compare -- --approve-spend --repo <path to another repository> \
  --tasks test/eval/shunt/compare-tasks.json \
  --worker-url http://127.0.0.1:11434 --worker-model qwen2.5:3b --out "$SCRATCH/compare.json"
```

Runs in enforce mode against a repository other than llm-fw (spec Assumptions). Expected: per arm,
prompt tokens, cache writes, cache reads, turns, correct answers, stored-original reads (module-on
arm), over tasks completed in both arms, and the net, even when it is a loss (US5-3). Without
`--approve-spend` it spawns nothing and reports the stage as not run (US5-4).

## 3. Documentation check (US4-7)

Read the "Tool result shunt" section of `docs/guides/token-savings.md` against every item of
FR-018, and confirm `CHANGELOG.md` has an `## [Unreleased]` entry for the module.
