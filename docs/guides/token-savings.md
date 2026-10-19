[llm-fw](../../README.md) > [Documentation](../README.md) > Token savings

# Token savings

The firewall already sits on every LLM request, so it can also make requests
cheaper before they leave. Each technique below is a separate gateway module
with its own switch, its own KPIs on the dashboard's **Modules** tab, and its
own live events. All of them are off by default, because each one changes what
the provider receives, except the usage meter and tool usage, which only read.

## Turning a module on and off

Every module has a `modules.<key>.enabled` config key. Each can be flipped live,
without a restart, in any of these ways:

- the toggle on its card in the dashboard's **Modules** tab, which also
  persists the change to `~/.llm-fw/config.json`,
- `POST /api/modules` with `{"id": "<module id>", "enabled": true}`,
- editing `config.json`, which is hot-reloaded,
- the `LLM_FW_*_ENABLED` environment variable, at start-up.

### Changing a module's options

Every option listed under a module below (`historyWindow.maxMessages`,
`toolResultTruncate.skipTools`, `cacheControl.ttl` and the rest) can be
changed live as well:

- under **Options** on the module's card in the dashboard's **Modules** tab,
  which validates each field against the module's bounds, applies the change
  to the next request and persists it to `~/.llm-fw/config.json`,
- `POST /api/modules` with `{"id": "<module id>", "options": {"maxMessages": 50}}`,
  alone or together with `"enabled"`; a bad value gets a 400 that names the
  option and nothing is changed, and `GET /api/modules` lists each module's
  `options` with their type, bounds and live value,
- editing `config.json`, which is hot-reloaded.

Changing an option of a rewriting module in the middle of a conversation has
the same effect as switching the module, under
[Changing a module in the middle of a conversation](#changing-a-module-in-the-middle-of-a-conversation).

## Token Economy, the parent switch

Every module is a sub-module of **Token Economy**. Its switch is
`modules.enabled` (default `true`, `LLM_FW_MODULES_ENABLED`), and off, no
module runs on the proxy or the gateway, the usage meter included. Turning it
off leaves each module's own switch as it was, so turning it back on restores
exactly the set that ran before. Flip it live, without a restart:

- the toggle on the **Token Economy** card at the top of the **Modules** tab,
  which dims the sub-module cards while it is off and persists the change to
  `~/.llm-fw/config.json`,
- `POST /api/modules` with `{"id": "token-economy", "enabled": false}`;
  `GET /api/modules` reports it as
  `"tokenEconomy": {"id": "token-economy", "name": "Token Economy", "enabled": true}`,
- editing `modules.enabled` in `config.json`, which is hot-reloaded.

Switching it changes what the provider receives on the next request, so on a
conversation that a rewriting module was already shaping, the next turn is one
cache write, the same as switching any one module.

## What every module guarantees

- **It runs before DLP and detection**, on the proxy and on the gateway, so
  both scan the body that is actually forwarded. Text a module removes never
  reaches the model, so it cannot carry an injection either.
- **It fails open.** A module that throws is logged and skipped, and the
  request continues with the body as the previous module left it.
- **Observe mode is a dry run.** The module runs and its card counts what it
  would have saved, but the original body is forwarded.
- **The same history comes out byte-identical on every turn.** A rewrite
  depends only on the text it rewrites and on what comes before it in the
  request, never on time or on how long the conversation is. Two things depend
  on that: the provider's prompt cache, which matches on the exact prefix,
  and, on models with preserved thinking (Claude Fable 5.1, Opus 5.5, Sonnet
  5.5, Haiku 5.5), the signature on every thinking block, which records the
  conversation before it.

### Clients that resend history, and clients that do not

Most clients resend the whole conversation on every request: the OpenAI and
Anthropic SDKs, and Claude Code when it is pointed at a custom base URL (the
gateway). Claude Code talking to `api.anthropic.com` through the proxy does
not: it opens a server-side thread (`thread: {"type": "create"}`) and then
sends only each turn's new content (`thread: {"type": "continue",
"previous_message_id": ...}`), and the server keeps the history. Measured in a
live session on 2026-10-17: after the first request, the requests carried no
tool list and two messages each, 11 to 47 KB, where the same task through a
custom base URL resent 207 to 331 KB per request.

For a thread client the modules rewrite each turn's new content once, and the
server keeps what was sent. The history window never cuts a thread
continuation, since its messages are all new, and the deduplicator can only
see repeats within one turn.

### Changing a module in the middle of a conversation

For a client that resends history, turning a rewriting module on or off, or
changing one of its options, changes how the earlier turns of a running
conversation are sent. The next request misses the prompt cache once. On
models with preserved thinking, accounts the provider enforces the check for
(Anthropic accounts created on or after 2026-08-31) get a 400 for that
conversation: "The block is bound to a different conversation." Start a new
conversation after changing a module, or change modules between sessions.
A server-side thread is not affected: its earlier turns are never sent again.

## How savings are counted

Each card counts tokens over the text the module examined, before and after,
never over the request body: re-serialising a pretty-printed JSON envelope
shrinks the body by bytes the model never sees.

The count is an estimate, made without a tokenizer dependency
(`src/modules/tokens.ts`). It cuts text the way a BPE pre-tokenizer does, so a
run of spaces counts as one token however long it is. Against the public
cl100k and o200k tokenizers its mean error is 4 to 8% on prose, code, JSON,
prompts and tool output, and 28% on base64. The 4-characters-per-token rule
it replaced overstated what collapsing whitespace saves on column-aligned
tool output by 75%. Claude's tokenizer is not public, so treat the numbers as
an approximation of any provider's bill.

## Measured on live Claude Code traffic

On 2026-10-17, Claude Code 2.1.302 with Claude Opus 5.5 ran read-and-summarize
tasks (read source files, grep, `git log`, list and summarize) through the
proxy: one observe pass on this repository with every module on, and two
enforcing A/B rounds on a clone of express with the rewriting modules off, then
on (everything but `collapseSpaceRuns`).

Share of the examined text each module removed, from its card:

| Module | Removed |
| --- | --- |
| `tool-result-truncate` | 11% of tool output (this repository), 26 to 28% (express) |
| `tool-result-pruner` | 5.2% of tool output with `collapseSpaceRuns` on; 0.4 to 0.6% without |
| `ansi-strip` | 1.8% of prompt and tool text with a coloured `git log` in it; 0.4% otherwise |
| `tool-definition-pruner` | 0.03% |
| `token-pruner` | 0.02% |
| `progress-collapse`, `repeat-collapse`, `blob-elide`, `tool-result-dedup` | 0: no task produced that kind of output |
| `history-window` | 0: Claude Code sends thread continuations, which it never cuts |
| `cache-control` | 0 requests marked: every request already carried Claude Code's own markers |
| `response-cache` | 0 hits: no request repeated |

What was billed, from the Usage Meter, which matched Claude Code's own usage
report to the token. Four tasks that completed in both configurations, two
rounds each:

| | Modules off | Modules on |
| --- | --- | --- |
| Cost | $2.68 | $2.52 (−5.7%) |
| Cache writes | 257,657 | 224,177 (−13%) |
| Cache reads | 1,288,014 | 1,658,814 (+29%) |
| Turns | 38 | 47 (+24%) |

The truncator is the only module that moved the bill, and it trades latency
for it: after a file read came back with `[llm-fw: N lines elided]`, the agent
read the elided range back, so sessions took more turns. Cache writes, which
cost far more per token than cache reads, still fell enough to lower the
total. The sample is small and the turn count varies from run to run, so read
the cost delta as a direction, not a guarantee. For Claude Code, the
whitespace modules are below 1% and not worth the risk they carry for edits.

Since this round the truncator leaves file reads whole (`skipTools`, under
[Tool result truncator](#tool-result-truncator)), and that gives up most of
what it cut. Over 30 days of one developer's Claude Code transcripts
(1,716 transcript files, 61,634 tool results, counted with the estimate above),
`Read` results were 62% of the tokens the truncator would remove, lean-ctx's
`ctx_read` 9% and `Bash` 22%. Skipping `Read` keeps 38% of the saving;
skipping `ctx_read` as well keeps 29%. What that does to the bill, net of the
turns it no longer adds, has not been measured.

## Modules

In pipeline order, which is also the order of the cards:

| Module id | Config key | Rewrites |
| --- | --- | --- |
| `history-window` | `modules.historyWindow` | drops the oldest turns of a long conversation (lossy) |
| `ansi-strip` | `modules.ansiStrip` | terminal escape codes in tool output and prompts |
| `progress-collapse` | `modules.progressCollapse` | progress-bar frames in tool output and prompts |
| `repeat-collapse` | `modules.repeatCollapse` | runs of identical lines in tool output |
| `blob-elide` | `modules.blobElide` | long base64 and hex runs in tool output |
| `lean-ctx` | `modules.leanCtx` | shell command output, file reads aside, through lean-ctx (lossy) |
| `token-pruner` | `modules.tokenPruner` | prompt and system text |
| `tool-result-pruner` | `modules.toolResultPruner` | tool output |
| `tool-result-dedup` | `modules.toolResultDedup` | repeated tool output |
| `tool-result-truncate` | `modules.toolResultTruncate` | the middle of oversized tool output, file reads aside (lossy) |
| `tool-filter` | `modules.toolFilter` | removes the tools you name from the tool list |
| `tool-definition-pruner` | `modules.toolDefinitionPruner` | tool and parameter descriptions |
| `tool-usage` | `modules.toolUsage` | nothing; lists the offered tools that never get called (on by default) |
| `tool-result-clear` | `modules.toolResultClear` | asks Anthropic to clear old tool results server side (lossy) |
| `stream-usage` | `modules.streamUsage` | asks OpenAI-style chat streams to report usage; saves nothing, makes the meter complete |
| `cache-control` | `modules.cacheControl` | adds Anthropic prompt-cache markers; saves cost, not tokens |
| `response-cache` | `modules.responseCache` | nothing; answers a repeated request from a stored response |
| `usage-meter` | `modules.usageMeter` | nothing; reads responses (on by default) |

### Tool result pruner

`modules.toolResultPruner.enabled` (`LLM_FW_TOOL_RESULT_PRUNER_ENABLED`).
Tool output (Anthropic `tool_result` blocks, OpenAI `tool` messages, Responses
API `function_call_output`) is usually most of an agent's input. Three
techniques, each with its own switch:

| Option | Default | Does |
| --- | --- | --- |
| `minifyJson` | `true` | A tool result that is a JSON object or array loses the whitespace outside its strings. Lexical, not parse-and-print: every number and string stays byte for byte, so `12345678901234567890` is not rounded. |
| `trimTrailing` | `true` | Spaces and tabs at the end of each line go. |
| `collapseSpaceRuns` | `false` | Runs of two or more spaces after a line's indentation become one. Saves the most on column-aligned command output (`ls -l`, `kubectl get`, `docker ps`). |

What to watch for: an agent quotes a file read verbatim in its next edit. With
`trimTrailing`, an edit whose quoted text spans a line that ends in spaces in
the file no longer matches. With `collapseSpaceRuns`, any edit of a line with
aligned spaces misses, which is why it is off. A single tab, such as the one
after a line number in Claude Code's file reads, is never collapsed.

### Tool result deduplicator

`modules.toolResultDedup.enabled` (`LLM_FW_TOOL_RESULT_DEDUP_ENABLED`), option
`minLength` (default `200` characters). Agents reread the same file and rerun
the same command, and every copy stays in the history they resend. A tool
result identical to an earlier one in the same request becomes
`[llm-fw: identical to the earlier tool result <id>]`, naming the first copy
by its tool call id (or `#n`, its position, when the format carries no id).
The first copy always stays, and which copy is kept depends only on what came
before it, so a growing conversation is rewritten the same way on every turn.

### Tool result truncator

`modules.toolResultTruncate.enabled` (`LLM_FW_TOOL_RESULT_TRUNCATE_ENABLED`).
**Lossy**: the model never sees what is cut. A build log or a full test run
can be tens of thousands of tokens, re-sent on every later turn, while the
head and tail usually carry the command, the error and the summary.

| Option | Default | Does |
| --- | --- | --- |
| `headLines` | `200` | Lines kept from the start of a tool result longer than `headLines + tailLines`. |
| `tailLines` | `100` | Lines kept from the end. The middle becomes `[llm-fw: N lines elided]`. Both `0` turns the line cut off. |
| `maxChars` | `40000` | After the line cut, a result still longer than this keeps two thirds of it from the head and one third from the tail, with `[llm-fw: N characters elided]` between; this catches one huge line, such as minified code. `0` is off. |
| `skipTools` | the file readers below | Tools whose results are never cut. |
| `skipCommands` | `cat`, `head`, `tail`, `sed`, `awk`, `nl`, `less`, `more`, `bat`, `tac`, `type`, `gc`, `Get-Content` | Programs that print a file. A result whose call has a `command` argument with any of these as a word (a shell tool running `cat src/x.ts` or `cd repo && sed -n 1,400p x.ts`) is never cut either. An entry with a hyphen matches in any case. |

File reads stay whole. In the live round above, Claude Code read files
through lean-ctx's `ctx_read` MCP tool, and after a read came back cut it read
the elided range back, so sessions took 24% more turns. The default
`skipTools` holds `Read` (Claude Code), `read_file` (Gemini CLI),
`read_text_file` and `read_multiple_files` (the MCP filesystem server), and
`str_replace_based_edit_tool` and `str_replace_editor` (Anthropic's text
editor tool, whose `view` command reads a file). A name matches the tool of
that name, or one whose name ends in `__` and that name, which is how Claude
Code names MCP tools (`mcp__filesystem__read_text_file`). Add the tool your
agent reads files with when it is not listed, such as `ctx_read`, which is
not in the default. The list replaces the default, so repeat the names you
keep:

```json
{ "modules": { "toolResultTruncate": { "skipTools": ["Read", "read_file", "ctx_read"] } } }
```

A tool result names its call, not its tool. A client that resends its
history (the SDKs, Claude Code through the gateway) carries the call in the
same request. Claude Code through the proxy continues a server-side thread
and sends results without their calls, as does the Responses API with
`previous_response_id`; there the module learns each call's tool from the
response that made it, the command included. A result whose tool it cannot
tell is cut: after a restart, while the module was off, or when that response
was larger than `proxy.maxBodyBytes`.

A file read through a shell tool is recognised by its command, not its tool:
a call whose `command` argument (a string, or Codex's argv array) has a word
in `skipCommands` stays whole, wherever the word sits (`cd repo && sed -n
1,400p x.ts`, `npm test | tail -30`). Over 30 days of one developer's Claude
Code transcripts (61,639 tool results), `cat`, `sed` and `awk` in `Bash` were
19.4% of the tokens the truncator removed, against 9.5% for all other shell
output, on a machine that denies the native `Read` tool and so pushes reads
into the shell. What the module still cuts there is command output proper:
test runs, build logs, `git log`.

For a client that resends its history, the cut depends only on the result
and the call before it in the request, so the same history is sent the same
way every turn; a thread continuation sends each result once. An agent that
reads a long file through a tool not in `skipTools` and then rewrites the
whole file would write the marker into it: add that tool, or keep this
module off for that agent.

### lean-ctx shell output compressor

`modules.leanCtx.enabled` (`LLM_FW_LEAN_CTX_ENABLED`). **Lossy**: sends the
output of shell commands to [lean-ctx](https://github.com/yvgude/lean-ctx),
which keeps the lines it ranks highest and replaces the rest with a line such
as `[46 lines omitted, 3 safety-relevant lines preserved]`. llm-fw starts a
private lean-ctx and talks to it over a loopback port. None of lean-ctx's code
is part of llm-fw.

Install lean-ctx yourself (`cargo install lean-ctx`, or a release binary from
its GitHub page) and put it on `PATH`, or set `LLM_FW_LEAN_CTX_BIN` to the
executable. That variable is read from the process environment only, like
`LLM_FW_DIR`: a project config file comes with whatever repository llm-fw is
started in, and must not choose a program for llm-fw to run. Do not install
lean-ctx through the `lean-ctx-bin` npm package for this: its install script
downloads the newest release whatever version you asked for, and runs
`lean-ctx onboard`, which reconfigures your AI tools. When lean-ctx is
missing or stops, results are forwarded whole and one warning is logged.

| Option | Default | Does |
| --- | --- | --- |
| `tools` | `["Bash", "PowerShell", "shell", "run_shell_command"]` | Shell tools whose results are sent, matched like `skipTools` above: Claude Code's `Bash` and `PowerShell`, Codex CLI's `shell`, Gemini CLI's `run_shell_command`. The call's `command` argument must be a string, or the argv array Codex sends (`["bash", "-lc", "npm test"]`), which is read as one line, so a file read behind `bash -lc` stays whole. |
| `skipCommands` | file printers, below | A result whose command has any of these as a word stays whole. |
| `timeoutMs` | `500` | How long a request waits for lean-ctx. A result it has not answered by then is forwarded whole, on that turn and every later one. |

Only a result whose command is known is sent: from the call in the same
request, or, for a thread continuation, from the response that made the call,
as the truncator learns tool names. File reads stay whole. The default
`skipCommands` holds the programs that print a file or part of one (`cat`,
`head`, `tail`, `sed`, `awk`, `nl`, `less`, `more`, `bat`, `tac`, `xxd`, `od`,
`hexdump`, `strings`), searches and diffs (`grep`, `rg`, `diff`, `show`,
`blame`, `findstr`) and their PowerShell forms (`type`, `gc`, `Get-Content`,
`Select-String`, `sls`). Any word of the command counts, so
`npm test 2>&1 | tail -30` stays whole too: the agent already chose the 30
lines it wants.

Measured over 30 days of one developer's Claude Code transcripts (52,907
unique tool results, 29.0M tokens by the estimate above) with lean-ctx 3.11.0:

- Sending every tool result to lean-ctx would remove 18.6% of their tokens
  beyond what the other tool-output modules remove. 18.2 points of that are lossy cuts,
  most of them file reads: a 361-line source file read came back as its first
  5 and last 10 lines. That is the cut the truncator stopped making.
- With this module's filter, shell output was 57% of the tool-result tokens,
  and 95.6% of it came from commands in `skipCommands` (`sed` 33.5%, `grep`
  28.9%, `cat` 16.7%). The module sent 3,362 results, 4.4% of the shell
  output, and removed 185,630 tokens: 0.64% of all tool-result tokens, 25% of
  what it sent.

A billed A/B on 2026-10-17: 16 Claude Code 2.1.302 sessions (Claude Opus
5.5) through the proxy on a clone of express, modules off against this module
on, four tasks built around one long command each (`npm test`,
`npm run test-cov`, `npm ls --all`, `npm run test-tap`), two rounds with
the arm order swapped, answers checked against ground truth recorded before
the run. Left to itself, the agent wrote the `npm test` output to a file and
read it with `tail` and `grep`, which `skipCommands` leaves whole, so the
module sent nothing. The prompts therefore asked for the commands unfiltered:

| | Modules off | `lean-ctx` on |
| --- | --- | --- |
| Tasks answered correctly | 8 of 8 | 6 of 8 |
| Turns | 24 | 23 |
| Prompt tokens | 720,758 | 661,013 (−8.3%) |

Both misses were `npm ls --all`: lean-ctx cut the 641-line dependency tree
to about 15 lines and headed it "15 errors", after packages named
`http-errors`, `es6-error` and `aggregate-error`, and the agent said it
could not answer. It did not rerun the command, and turns did not go up. The
billed cost is left out because it mostly measured run order: the arm that ran
first in round one paid 62% of all cache writes.

Keep this module off for an agent whose answer can depend on a line in the
middle of command output. Its cuts are silent: the agent could report that it
lacked the answer, not recover it.

How llm-fw runs lean-ctx:

- `lean-ctx proxy start` on a free loopback port, used only for its
  `POST /v1/compress` endpoint, one result per call. Given a whole
  conversation, lean-ctx rewrites only the last three messages, so a result
  would change form as the conversation grows.
- Its own data, config, state and cache folders under `<LLM_FW_DIR>/lean-ctx/`,
  a random token, and telemetry off (`DO_NOT_TRACK=1`,
  `LEAN_CTX_TELEMETRY=off`; lean-ctx sends telemetry by default). Of
  llm-fw's environment it gets only `PATH`, `HOME`, the temp folders and the
  like, so provider keys never reach it.
- lean-ctx stores the original of every lossy result on disk and appends an
  instruction telling the model to retrieve it. llm-fw blocks the store (a
  file where lean-ctx's `tee` folder would be) and strips any such
  instruction: there is no retrieve tool behind llm-fw, and the instruction
  would land in a tool result that llm-fw's detectors scan.
- Each result's output is decided the first time it is seen and remembered
  for the last 4,096 results, so a history comes out the same on every turn.
  lean-ctx's output for a given result was byte-identical in 834 of 834
  samples, across a restart of lean-ctx too. The exception is a result
  forwarded whole because lean-ctx did not answer in time: after llm-fw
  restarts, or once it is no longer among the 4,096, it can come back
  shortened, with the consequences described under
  [Changing a module in the middle of a conversation](#changing-a-module-in-the-middle-of-a-conversation).
- lean-ctx starts on the first request that needs it (45 to 78 ms on the
  machine above) and stops when llm-fw exits, when the module is switched off
  on the dashboard or through `POST /api/modules`, or after 10 minutes without
  a request that needed it. The idle stop is what covers a `config.json`
  edit, which flips the switch without telling the module. The next request
  that needs it starts it again.
- The Docker image does not include lean-ctx, so there the module forwards
  every result whole.

### Tool filter

`modules.toolFilter.enabled` (`LLM_FW_TOOL_FILTER_ENABLED`), `modules.toolFilter.dropTools`.
An agent sends a definition for every tool it has on every request, used or
not, and the provider bills the whole list each time (as a cache read once it
is cached). This removes the tools named in `dropTools`: an exact name, or a
pattern where `*` matches any run of characters, over the whole name
(`mcp__axiom__*`, `Cron*`). The list is empty by default, so turning the
module on changes nothing until you name tools; which tools a client never
needs is your call, and the model cannot call a tool it is not shown.

What stays even when it is named:

- a tool the conversation has already called, or that `tool_choice` (Gemini:
  `allowedFunctionNames`) forces, since the provider refuses a request that
  references a tool it was not given;
- a tool that carries a `cache_control` breakpoint, which the client placed;
- every tool, when all of them would go;
- server tools without a name (`{"type": "web_search"}`), and tools a
  conversation adds as `tool_addition` blocks, which are left to the client.

A tool kept because the history calls it changes the tool list on the turn the
call first appears, which is one cache write, the same as switching the module.
Name only tools a client does not call, and that turn never comes.

Measured on one captured Claude Code 2.1.302 request (44 tools, 21,798 tokens of
definitions, sent on every request by a client pointed at a custom base URL):
naming 27 tools, 26 that 30 days of this developer's transcripts never called
and `Workflow`, called once (DesignSync, the cron and worktree tools, LSP,
NotebookEdit, two MCP servers), cut the
definitions to 11,347 tokens, 48%. Its effect on the bill is not measured; the
tool list is a cache read on most turns, so expect a tenth of that in cost
between cache writes, and the full amount on each write.

### Tool usage

`modules.toolUsage.enabled` (`LLM_FW_TOOL_USAGE_ENABLED`), on by default
because it changes nothing. It answers the question the tool filter leaves to
you: which tools does this client never call? It records every tool a request
offers, with the token estimate of its definition, and every call it sees, from
the request history and from responses (a request that continues a server-side
thread, as Claude Code does through the proxy, carries the results but not the
calls). Its card lists the tools no call has named yet, largest first, with
their combined tokens per request: names you can copy into
`modules.toolFilter.dropTools`. It runs after the tool filter and the
definition pruner, so the list is what still costs.

Why it matters: across 14 days of one developer's Claude Code transcripts
(34,209 assistant turns), cache reads were 78.5% of the bill by list-price
weights, and the tool list is part of that prefix on every turn. A captured
request carried 21,798 tokens of definitions, an estimated 6% of the bill at that
turn count (21,798 x 34,209 turns x 0.1, not measured per request), while those
sessions called 44 distinct tools in total. A tool that
has not been called yet may still be needed; the list is evidence, not a
verdict.

`llm-fw start` keeps the list across restarts in `<LLM_FW_DIR>/tool-usage.json`
(tool names, their token estimates and the call counts; no request content),
written at most every 5 seconds and on a graceful stop, so it builds up over
days of traffic instead of starting empty each time. Resetting the module's
stats empties it; `uninstall --purge` deletes it.

### Tool definition pruner

`modules.toolDefinitionPruner.enabled` (`LLM_FW_TOOL_DEFINITION_PRUNER_ENABLED`).
An agent sends its whole tool list, descriptions included, on every request.
This applies the token pruner's rules to each tool's `description` and to
every `description` inside its parameter schema, in the Anthropic, OpenAI chat,
Responses API and Gemini shapes, and in tools added mid-conversation as
`tool_addition` blocks of a system message. Tool names, enum values and schema structure
are never touched, because they are the contract with the tool. The tool list
sits at the very front of the cached prefix, so this costs one cache miss when
it is switched, and nothing after.

### Server-side tool result clearing

`modules.toolResultClear.enabled` (`LLM_FW_TOOL_RESULT_CLEAR_ENABLED`).
**Lossy**: the model no longer sees old tool output. Anthropic's context
editing replaces the results of old tool calls with a placeholder on the
server, before the model reads the request. The client still sends the whole
history, and the provider bills the edited one. For an Anthropic Messages
request (`api.anthropic.com`, `/v1/messages`) this adds a
`clear_tool_uses_20250919` edit to `context_management.edits`, after any edit
the client sends itself.

| Option | Default | Does |
| --- | --- | --- |
| `triggerTokens` | `100000` | Input tokens a request must pass before anything is cleared. |
| `keepToolUses` | `10` | The most recent tool calls whose results stay. |
| `clearAtLeast` | `20000` | Input tokens each clearing must remove, or `0` for no minimum. |
| `excludeTools` | the file readers, as the truncator's `skipTools` | Tools whose results are never cleared, by exact name. Add `mcp__lean-ctx__ctx_read` if you read files through lean-ctx. |

The API refuses the field without the `context-management-2025-06-27` beta
in `anthropic-beta` (400, "Extra inputs are not permitted"). Claude Code
sends it, together with its own `clear_thinking` edit; a plain SDK client
does not, so the module appends it to whatever betas the client sent, and
the proxy or the gateway puts the header on the upstream request. The card
counts those under **Beta header added**. A request that already carries a
`clear_tool_uses` edit is left alone. The card also counts what the server
reports in `applied_edits`: responses cleared, input tokens cleared and tool
results cleared, so the saving shown is the provider's own count, not an
estimate.

Why `clearAtLeast` matters: clearing changes the prompt from the first
cleared result onwards, so the cache is written again from there. Clearing
one result per turn as the window slides rewrites the cache every turn.
Modelled over 14 days of one developer's Claude Code transcripts (1,333
transcripts, 29,908 API calls, list-price weights: input 1, cache read 0.1,
output 5, cache write 1.25 for five minutes and 2 for one hour, which is
what Claude Code writes for 88% of its cache; tokens as characters / 4):

| Trigger | Keep | Clear at least | Cache reads saved | Cache rewrites | Net, share of the bill |
| --- | --- | --- | --- | --- | --- |
| 100,000 | 10 | 0 | 16.7% | 23.5% | −6.8% (a loss) |
| 100,000 | 10 | 20,000 | 14.7% | 1.6% | 13.1% |
| 60,000 | 5 | 20,000 | 15.1% | 1.4% | 13.7% |
| 150,000 | 20 | 40,000 | 12.0% | 1.3% | 10.7% |

Setting `clearAtLeast` to `0` costs more than it saves.

That is a ceiling, not a measurement: it leaves out the turns an agent spends
calling a tool again for output that was cleared. Leaving file reads alone
(and lean-ctx's `ctx_read`) still leaves a ceiling of 10.9% on the same
transcripts.

Measured on 2026-10-18, Claude Code with Claude Haiku 5.5 through a relay
running this module, three read-heavy tasks on this repository, two rounds:

| Task | Off | On, file reads cleared | On, file reads kept (default) |
| --- | --- | --- | --- |
| Read 14 module files, answer three questions | 16 to 17 turns, $0.021 to 0.026 | 17 to 18 turns, $0.023 to 0.024 | 16 turns, $0.020 |
| Read two 700 to 1,600-line files in full | 9 to 11 turns, $0.047 to 0.070 | 8 to 9 turns, $0.062 to 0.071 | 10 turns, $0.072 |
| Read 22 files, then answer across all of them | 23 to 25 turns, $0.134 to 0.143 | **57 to 75 turns, $0.367 to 0.585** | 24 turns, $0.134 |

Clearing file reads made the agent read the files again ("Many tool results
were cleared during the session, so I re-read them"), and the cleared re-reads
were cleared in turn: up to 4.4 times the cost, with the same answer. That is
why file readers are excluded by default. With them kept, these tasks cost the
same as with the module off, because nearly all their tool output was file
reads. A saving on long sessions with heavy shell or search output, which is
where the ceiling above comes from, has not been measured.

Verified against the API on 2026-10-18 through Claude Code's own
credentials: `keep: 1` on a request with three tool results cleared the two
oldest (9,331 input tokens), and the next identical request read the edited
prompt from the cache with nothing written. The edit is the same on every
request, so it never breaks the request prefix; turning the module on or off
mid-conversation changes what the server bills from that point, which costs
one cache write. Not verified: a Claude Code thread continuation through the
proxy (`thread.type` is `continue`), where the server holds the history.

### Stream usage reporter

`modules.streamUsage.enabled` (`LLM_FW_STREAM_USAGE_ENABLED`). An OpenAI
chat completions stream reports its token usage only when the client asks
with `stream_options: {"include_usage": true}`, and most clients do not, so
the usage meter cannot meter those streams. This sets it on every streaming
`/chat/completions` request that does not already, on any host that serves
that path (OpenAI, Azure OpenAI, Groq, Together), keeping the client's other
stream options. Saves nothing by itself; it makes the Usage Meter's totals
complete for OpenAI-style clients.

What changes for the client: one more chunk at the end of the stream, with an
empty `choices` array and the `usage` object, which is how the API documents
the option. The official OpenAI SDKs handle that chunk; a client that reads
`choices[0]` without checking the array gets `undefined` there. That is why it
is opt-in. No message text is touched, so the prompt cache is unaffected. Not
verified against each SDK's stream parser; check yours with the module on
before relying on it.

### Prompt cache marker

`modules.cacheControl.enabled` (`LLM_FW_CACHE_CONTROL_ENABLED`). Anthropic
caches a prompt prefix only when the request asks for it, and a cached prefix
is billed at a fraction of the input price on every later request that
repeats it. For an Anthropic Messages request (`api.anthropic.com`,
`/v1/messages`) that carries no `cache_control` anywhere, this adds the
top-level automatic breakpoint, which follows the end of the conversation
turn by turn.

| Option | Default | Does |
| --- | --- | --- |
| `ttl` | `5m` | `5m`, or `1h`. A one-hour entry costs twice as much to write and survives gaps between requests longer than five minutes. |
| `cacheSystem` | `true` | Also marks the last block of the system prompt (a string prompt becomes one text block), so separate conversations that share tools and system prompt share that entry. |

A request that places any marker of its own is left alone: the client has
already decided, and a request may hold at most four. Claude Code places its
own, so this changes nothing for it; the card counts both cases. Writing an
entry costs more than an uncached read (1.25 times the input price for five
minutes), so a one-off request that is never repeated pays more, and a
prefix shorter than the model's minimum (512 to 4,096 tokens) is not cached
at all. Check the Usage Meter's cache reads to see whether it pays. Under
observe mode the original body goes upstream, and the card counts the request
under **Would mark** instead.

### Response cache

`modules.responseCache.enabled` (`LLM_FW_RESPONSE_CACHE_ENABLED`). A request
that is byte-identical to an earlier one, from the same credential, within the
TTL, is answered with the stored response and never reaches the provider. The
reply carries `x-llm-fw-cache: hit`. Useful for retries, evaluation reruns and
scripted agents that ask the same thing twice. A person who asks again
expecting a fresh answer gets the old one, which is why it is opt-in and the
TTL is short.

| Option | Default | Does |
| --- | --- | --- |
| `ttlSeconds` | `300` | How long a stored response may be replayed. |
| `maxEntries` | `100` | Responses kept; the least recently used goes first. |
| `maxEntryBytes` | `524288` | Largest response body stored. With the defaults the cache holds at most about 50 MB. |

The key is the target, method, the URL as the client sent it (query
included, since Google takes its key as `?key=`), tenant, client address,
request body after the other modules, and the headers that decide whose
request it is or shape the answer: `authorization`, `x-api-key`,
`x-goog-api-key`, `api-key`, `x-llm-fw-key`, `cookie`, `anthropic-version`,
`anthropic-beta`, `openai-beta`, `openai-organization`, `openai-project`,
`x-goog-user-project`, `accept` and `accept-encoding`. One caller is never
served a response fetched with another's key, and a request that carries no
credential at all (no such header, tenant or query key) is neither stored nor
answered. A stored response loses its `set-cookie` header. Only complete
`200` responses are stored, streamed or not. A replay runs every request-side
gate first, and on the proxy it then goes through the response-side gates as
a live response would, under the policy in force at replay time: MCP tool
policy, the exfil scan (neutralized in block mode), the tool-call and harm
scans; a stored stream gets the audit-only scans a live stream gets. So a
policy tightened after a response was stored still applies to it. It never
answers under observe mode, which promises that the provider sees every
request. The agent loop detector still refuses a request repeated too many
times, before the cache is asked. The card counts hits, misses, stored
responses and the billed tokens hits avoided (from the stored usage). The
cache lives in the process, like quotas: replicas do not share it, and a
restart empties it.

### Usage meter

`modules.usageMeter.enabled` (`LLM_FW_USAGE_METER_ENABLED`), **on by
default**, because it reads responses and changes nothing. It adds up the token
counts the provider reports in each response, so the estimates on the other
cards can be checked against the bill:

- **Uncached input**: input billed at the full rate,
- **Cache reads** and **cache writes**: the prompt-cache traffic that decides
  what a long agent session costs,
- **Output**,
- **Input served from cache**: cache reads over all input,
- **Billed input per estimated text token**, over the responses compared:
  the billed input (uncached, cache reads and writes) divided by the estimate
  from [How savings are counted](#how-savings-are-counted) over the text of
  the request that earned it. The estimate is fitted to public tokenizers and
  Claude's is not public, so this is the only measure of its error on the
  traffic you send. The estimate covers the request's text (tool descriptions,
  system prompt, conversation, tool results), not the JSON around it or the
  tool schemas' structure, so expect a ratio above 1; what matters is that it
  holds steady, and by how much. A request whose history the server holds
  (a Claude Code thread continuation, a Responses API request with
  `previous_response_id`) is billed for text it does not carry, so it is
  left out, and **Responses compared** says how many went in.

It reads Anthropic `usage` (JSON and the `message_start` / `message_delta`
stream events), OpenAI chat `usage` (a stream carries it only when the client
sends `stream_options.include_usage`; the
[stream usage reporter](#stream-usage-reporter) adds it), the Responses API `response.completed`
event, and Gemini `usageMetadata`. A response larger than `proxy.maxBodyBytes`
is not metered, so a large download is never held in memory twice.

### History window

`modules.historyWindow.enabled` (`LLM_FW_HISTORY_WINDOW_ENABLED`). **Lossy**:
the model no longer sees the turns it drops.

| Option | Default | Does |
| --- | --- | --- |
| `maxMessages` | `100` | Turns kept, not counting leading system and developer messages or the top-level system prompt, which always stay. At least `2`. |
| `step` | `25` | Turns dropped at a time. |

When a conversation is longer than `maxMessages`, the oldest turns are dropped
in whole steps. The kept history starts at the step, or at the user turn right
after it when the step lands on an assistant turn, and the first kept turn
starts with `[llm-fw: N earlier messages omitted]`. A tool result whose call
was dropped is sent as user text behind `[llm-fw: result of an omitted tool
call]`, because providers refuse a result whose call is not in the request.
The cut therefore never waits for a plain user turn, which an agent loop may
not have for hundreds of turns. Works on OpenAI chat `messages`, Anthropic
`messages`, Gemini `contents` and a Responses API `input` array, where the
cut lands on a user message or on a `function_call_output` (one whose
`function_call` was dropped becomes user text the same way) and `reasoning`
items in the kept history are dropped, as thinking blocks are below.
Requests whose history lives on the server are left alone: a Responses API
request with `previous_response_id`, and an Anthropic thread continuation
(`thread.type` is `continue`), whose messages are all new.

What it costs:

- **One prompt-cache miss per step.** Between steps the kept history is a
  stable prefix and the cache keeps matching; a larger `step` means fewer
  misses and more turns kept on average.
- **Thinking blocks in the kept turns are removed.** Dropping turns changes
  the conversation every later thinking block was signed against, and models
  with preserved thinking refuse a block whose prefix changed. The model loses
  that reasoning, and an assistant turn that held nothing else becomes
  `[llm-fw: reasoning omitted]`. Anthropic's server-side compaction
  (`context_management`) keeps it and summarizes instead of dropping, so a
  client that can use it should prefer it.

### ANSI escape stripper

`modules.ansiStrip.enabled` (`LLM_FW_ANSI_STRIP_ENABLED`). Removes terminal
escape sequences from tool output and user prompts: colour and style codes
from test runners and linters, cursor movement and line erasure, window
titles, and OSC 8 hyperlinks (the link text stays). A coloured test summary
spends several tokens per escape on text the model cannot see. Nothing
printable is removed.

### Progress bar collapser

`modules.progressCollapse.enabled` (`LLM_FW_PROGRESS_COLLAPSE_ENABLED`). A
progress bar or spinner captured from a terminal (npm, pip, docker pull, curl)
arrives as every frame it drew, separated by bare carriage returns. Each line
keeps only its last frame with text, which is all the terminal ever showed. A
carriage return that ends a CRLF line is a line ending and stays.

### Repeated line collapser

`modules.repeatCollapse.enabled` (`LLM_FW_REPEAT_COLLAPSE_ENABLED`), option
`minRun` (default `3`, at least `2`). A run of `minRun` or more identical lines
in tool output (a retry loop, a warning per file, a polling script) becomes
its first line followed by `[llm-fw: previous line repeated N more times]`.
Lines compare exactly, whitespace included; blank lines are left to the
whitespace pruners. Tool output only, because a user who pastes a line five
times may mean it. An agent that reads a data file with repeated lines sees
the marker instead of the lines, so an edit that quotes the run would miss.

### Blob elider

`modules.blobElide.enabled` (`LLM_FW_BLOB_ELIDE_ENABLED`), option `minLength`
(default `2048` characters, at least `64`). A run of base64, base64url or hex
characters in tool output that is at least `minLength` long and holds both a
digit and a letter (an image embedded in an API response, a certificate, a
source map) becomes `[llm-fw: N-character base64 blob elided, sha256
1a2b3c4d]`. The hash keeps two different blobs distinguishable and the same
blob reading the same on every turn. A `data:...;base64,` prefix stays, and so
does the JSON around a blob, since the marker holds no quote or backslash.
Tool output only: a user who pastes base64 into a prompt may want it decoded.
An agent that reads a file holding a blob and then rewrites the whole file
would write the marker, so leave it off for agents that edit such files.

### Token pruner

`modules.tokenPruner.enabled` (`LLM_FW_TOKEN_PRUNER_ENABLED`). Collapses
interior runs of spaces and tabs to one space, runs of blank lines to one, and
trailing whitespace, and minifies multiline JSON embedded in the text, keeping
every number and string byte for byte. Leading indentation and fenced code are
kept.

It rewrites user, assistant and system text in OpenAI chat, the OpenAI
Responses API (`input`, `instructions`), Anthropic (`messages`, `system`) and
Gemini (`contents`, `systemInstruction`). It never touches tool output: an
agent quotes a file read verbatim in its next edit, so a collapsed run of
spaces there makes the edit miss. It never touches thinking blocks either.

An unfenced string literal with aligned spaces is altered, which is why it is
opt-in.
