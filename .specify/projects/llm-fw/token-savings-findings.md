# Token-saving modules: measured findings

Measured in the PR #351, #364 and #370 sessions (2026-10-17) with scratch
harnesses that are not in CI. Treat the numbers as dated observations.

## Constraints on any module that rewrites a request

- Preserved-thinking models (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5) sign
  each thinking block against the prefix before it. Accounts created on or after
  2026-08-31 get a 400 when that prefix changes. A rewrite must be a function of
  the slot and what precedes it, so out(n) is a prefix of out(n+1). Test it that
  way. The same property keeps the prompt cache warm.
- A rewrite whose output can vary between calls (a model-written summary) must
  therefore be computed once per slot and replayed byte-identical on every later
  request that carries that slot.
- Toggling a rewriting module mid-conversation breaks that conversation on
  enforced accounts.

## Traffic shape

- Claude Code through the proxy (first-party host) uses server-side threads:
  `thread: {type: continue, previous_message_id}`, only new messages per
  request, tools only on `create` plus `tool_addition` blocks. Continuations
  carry no tool_use, so tool names must be learned from responses.
- Through the gateway or any custom base URL it resends the full history,
  207-331 KB per request.

## What earlier modules measured

- Truncator, billed A/B on an express clone: cost -5.7%, cache writes -13%, but
  turns +24% because the agent re-reads the elided ranges. Every other module
  moved cost by under 1%.
- lean-ctx shell module (#370): 0.64% of tool-result tokens. Billed A/B: prompt
  tokens -8.3%, correct answers 8/8 to 6/8. Lossy cuts produced wrong answers the
  agent could not detect.
- Where truncated tokens come from over 30 days: Read 61.5%, ctx_read 9.2%,
  shell sed/cat/awk 19.4%, real command output about 10%.
- Whitespace pruning: 0.3% of prose, 0.5% of code, 3.2% of column-aligned tool
  output. chars/4 overstated the tool-output saving by 75%. A CRLF checkout
  inflated measured savings 2.6x; normalise samples to LF.

## Measurement methods that work

- **Offline replay first.** Stream `~/.claude/projects/**/*.jsonl` (30 days was
  1.9 GB and took seconds), pair each tool_use id, name and input with its
  tool_result, and run the built `dist/` module functions over the results.
  Free, deterministic, and the first number to quote.
- **Billed A/B second, with the user's go-ahead.** `claude -p --output-format
  json` per prompt (usage and cost are in the JSON) through a spare-port instance
  (scratch `LLM_FW_DIR`, CA from `new CertFactory().ensureCA()`), with
  `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` set only for the child, plus
  `--setting-sources project --strict-mcp-config`. Spawn it async; `spawnSync`
  blocks an in-process mock. Compare prompt tokens, not billed cost: cache
  prefixes shared across sessions confound cost. Compare only tasks that
  completed in both arms, and score correctness as well as tokens.
- Enforce mode refuses reads of llm-fw's own detection docs and source (#349).
  Run an A/B in observe mode or against another repository.
