# Quickstart: hand-run checks for the Tool Result Shunt

Automated tests cover behaviour (tasks.md). These checks need a person, a local model or money.

## 1. Replay stage (free; US5-1, US5-2, US5-5; SC-001, SC-002, SC-003, SC-010)

Prerequisites: a worker on this machine serving the OpenAI-compatible chat API, for example
`ollama pull qwen2.5:3b` and `ollama serve`; recorded Claude Code sessions under
`~/.claude/projects`.

Give the worker a context window that holds the largest result it is sent. Ollama cuts a longer
input silently, and the module then forwards that result whole with a `partial-input` warning
(D12). Ollama's window defaults to 4k, 32k or 256k tokens by VRAM (`ollama serve --help`); set it
with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`, then check `context_length` in
`curl -s http://127.0.0.1:11434/api/ps` after a first request (both verified 2026-10-17, Ollama
0.31.1). `qwen2.5` read about 0.45 tokens per character of numbered test output (13,566 for 30,349
characters), so a 32,768-token window holds results up to roughly 55,000 characters with room for
the answer; lower `maxInputChars` to match (D13).

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
FR-018, including the worker's context window (D12), the restart, the retention period and the
later flag (D9, D11). Confirm that the guide's "What every module guarantees" list and the
dashboard's modules blurb (`src/dashboard/server.ts`) no longer claim that every module runs before
DLP and detection or that every history is byte-identical whatever the time, and that `CHANGELOG.md`
has an `## [Unreleased]` entry for the module.
