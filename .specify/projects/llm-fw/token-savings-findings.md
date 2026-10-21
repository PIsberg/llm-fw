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

## Candidate token-saving extensions (2026-10-21)

1. **Cross-turn thread deduplication & `<system-reminder>` dedup (`tool-result-dedup`)**: implemented. Chains seen `sha256(result) -> toolCallId` and `<system-reminder>` hashes across server-side thread continuations (`thread.previous_message_id` / `previous_response_id`) via `observeResponse`, and collapses duplicate `<system-reminder>` blocks after their first occurrence. The pending state is keyed on the request's `GatewayModuleContext` object, not a hash of the body: `observeResponse` gets the body after every later module and DLP, so a body key broke the chain whenever anything after dedup changed the request.
2. **Search path grouping & internal stack-frame collapsing (`tool-result-pruner`)**: implemented. Groups contiguous `file:line:content` (`grep`/`rg`/`tsc`) output under a single `<file>:` header, keeping every match, and collapses contiguous `node_modules/` / `node:internal/` stack frames. The prefix must look like a path (a separator or an extension, no whitespace).
3. **Tool schema metadata pruner (`tool-definition-pruner`)**: strip non-contract JSON Schema fields (`title`, `examples`, `$comment`, `$schema`) from `input_schema` / `parameters`.
4. **HTML / SVG / source-map noise elider (`blob-elide`)**: elide inline `<svg path d="...">`, `sourceMappingURL=data:...`, and single-line minified bundles in `tool_result`.
5. **Lockfile & generated-file diff elider**: elide hunk bodies for `package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`, and `*.min.js` inside `git diff` / `git show` tool outputs while keeping stat headers.

### Measured, 2026-10-21

Offline replay of 30 days of Claude Code transcripts (1,300 sessions, 23.2M
tool-result tokens by `estimateTokens`), harness `scratch/replay-savings.mjs`,
`main` against the working tree:

| | `main` | This change |
| --- | --- | --- |
| Pruner, final full-history request | 0.07% of request tokens | 0.32% |
| Dedup, final full-history request | 0.61% | 0.61% |
| Dedup, thread continuations (only new messages sent) | 0.00% | 0.70% |
| Dedup, thread continuations, body rewritten after dedup | not measured | 0.70% |

- File-path grouping removes 1.27% of tool-result tokens, stack-frame collapse
  0.06%. Before the path check, grouping removed 1.59%: about a fifth of it
  came from ISO timestamps and `gh run view --log` lines split as
  `file:line:`, which rewrote log text rather than shortening paths.
- The first version keyed the thread chain on a hash of the body. With a
  rewrite between dedup and `observeResponse`, which is what the proxy and the
  gateway do whenever a later module or DLP changes the request, thread-mode
  savings fell from 0.69% to 0.11% (measured by the session that found it, not
  rerun). Keyed on the context object, both columns read 0.70%.
- `<system-reminder>` dedup adds about 1k tokens over 30 days: transcripts
  keep few reminders, so this replay undercounts what the live requests carry.
- The first version capped a file at 50 grouped matches; the cap fired 16
  times in 30 days and dropped matches the agent could only get back by
  rerunning the search. Removed: grouping is lossless.
- Live A/B with Claude Code (Sonnet) through a spare-port instance, about
  $0.33, run on the first version and not rerun after the fixes: on a
  find-and-fix task the pruner cut 32.6% of tool-result tokens, about 1.9% of
  billed prompt tokens per run, matched runs only; on a re-read and re-run task
  dedup saved 705 tokens alongside the pruner, 1.3% of billed prompt tokens.
  The ceiling is low because about 30k tokens per turn are system prompt and
  tool definitions, which neither module touches. Every run completed its task.
- Thread shape re-checked live the same day: one `claude -p` session
  (Claude Code 2.1.306, Sonnet, $0.08) through a spare-port proxy in observe
  mode, request shapes logged by a preload. The first request was
  `thread: {"type": "create"}` with 16 tools and 80 KB; the three after it were
  `{"type": "continue", "previous_message_id": ...}` with one message each,
  1 to 5.5 KB, no tools. So the thread-continuation column, not the
  full-history one, is what proxied Claude Code traffic gets, and on `main`
  the deduplicator saves nothing there. In that session the dedup would have
  removed 96 of 6,141 tokens and the pruner 734 of 2,403; the task completed.
