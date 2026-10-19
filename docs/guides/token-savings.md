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
  reaches the model, so it cannot carry an injection either. The tool result
  shunt is the exception: it runs after them, because it needs to know what
  they flagged, and the text it writes is never scanned (see
  [After DLP and detection](#after-dlp-and-detection)).
- **It fails open.** A module that throws is logged and skipped, and the
  request continues with the body as the previous module left it.
- **Observe mode is a dry run.** The module runs and its card counts what it
  would have saved, but the original body is forwarded.
- **The same history comes out byte-identical on every turn.** A rewrite
  depends only on the text it rewrites and on what comes before it in the
  request, never on how long the conversation is, and, with one exception,
  never on time. The tool result shunt has a worker model write its text, so it
  remembers what was written for `retentionHours`, and a result that no request
  carried for that long can come back worded differently (see
  [Remembered outcomes](#remembered-outcomes)). Two things depend
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
| `tool-result-shunt` | `modules.toolResultShunt` | very large shell, search and listing output, as a list of facts a local model read from it, with the original kept in a file; runs after DLP and detection (lossy) |
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
- The Docker image does not include lean-ctx unless it was built with the
  `LEAN_CTX_VERSION` and `LEAN_CTX_SHA256` build arguments (see
  [Docker](deployment-server.md#docker)); without them the module forwards
  every result whole there.

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

Once 1,000 calls have been seen, the card offers the list as one click:
**Drop these N tools in the Tool Filter** writes every never-called tool the
filter does not already match into `modules.toolFilter.dropTools`, keeping
what is there, and switches the filter on. The click is armed first and sent
on a second click, since it changes what the model can call, and the list is
evidence, not a verdict: a tool that has not been called in 1,000 calls may
still be needed (`AskUserQuestion`, say), so read the list before you click.
The filter keeps any tool a conversation has already called, whatever the
list says. The threshold is not configurable; the card says how many calls
it has seen until then.

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

### Tool result shunt

`modules.toolResultShunt.enabled` (`LLM_FW_TOOL_RESULT_SHUNT_ENABLED`). **Lossy
in what the model sees; the original stays on disk.** A full test run, a build
log or a recursive `grep` can be tens of thousands of tokens, and the agent
sends it again on every later turn. This module sends such a result once to a
model running on this machine, the worker, which lists the facts in it, and
forwards that list in its place. The complete original is written to a file and
the list names the file, so the agent can read any line range of it with its
own file-reading tool.

It does nothing until a worker is named. The worker is any server on this
machine that speaks the OpenAI chat API (`POST /v1/chat/completions`), such as
Ollama, and its replies must report `usage.prompt_tokens` (see
[Worker context window](#worker-context-window)). Only `enabled` has an
environment variable; the worker is set in the config file:

```json
{ "modules": { "toolResultShunt": { "enabled": true, "workerUrl": "http://127.0.0.1:11434", "workerModel": "qwen2.5:3b" } } }
```

| Option | Default | Does |
| --- | --- | --- |
| `workerUrl` | empty | Base URL of the worker. Only `http` or `https` with `localhost`, a `127.x.x.x` address or `::1` is accepted: for any other host nothing is sent and one warning is logged. Empty means no worker. |
| `workerModel` | empty | Model name passed to the worker. Empty means no worker. |
| `tools` | shell, search and listing tools, below | Tools whose results may be condensed, matched like `skipTools` above. The list replaces the default. |
| `minLines` | `350` | A result with at least this many lines is eligible. |
| `minChars` | `20000` | A result with at least this many characters is eligible too. |
| `maxInputChars` | `200000` | Largest result sent to the worker; a larger one stays whole. Set it to what the worker's window holds (below). |
| `waitMs` | `15000` | The most one request waits for the worker, however many results it carries. A result it has not answered by then is forwarded whole. |
| `retentionHours` | `24` | Hours a stored original and a remembered outcome are kept after the last request that carried the result. |
| `maxStoreMB` | `200` | Cap on the folder of stored originals. A write that would pass it is refused; nothing is deleted to make room. |

All of them are applied live. The default `tools` are `Bash`, `PowerShell`,
`BashOutput`, `Grep`, `Glob`, `LS`, `shell`, `exec_command`,
`run_shell_command`, `search_file_content`, `glob` and `list_directory`. No file
reader is in it, on purpose: a condensed file read makes the agent read the file
back, which is what the truncator's file reads taught (above).

A result is condensed only when all of these hold. Any other result is
forwarded whole, and the card counts it under the reason:

- Its tool is in `tools`.
- Its call did not ask for part of something (`offset`, `limit`, `view_range`,
  `head`, `tail`, `start_line` or `end_line` among the arguments) and does not
  name a stored original, which is the agent reading one back.
- It has at least `minLines` lines or `minChars` characters, and at most
  `maxInputChars` characters.
- Its tool is known: from the call in the same request or, for a thread
  continuation, from the response that made the call, as the truncator learns
  tool names.
- The caller is on this machine. A request from another address gets every
  result whole and nothing is stored, because the file would be on the wrong
  machine.
- Detection and DLP scanned it and flagged nothing in it
  ([below](#after-dlp-and-detection)).

What the agent receives in place of the result:

```
[llm-fw: tool output condensed from 1203 lines and 51842 characters.
The complete, exact original is in this file; read it, or any line range of it, with your file-reading tool:
<llm-fw directory>/tool-results/<sha256 of the original>.txt
Line numbers below are line numbers of that file.]
<the worker's list of facts>
```

The worker is told to list failures and errors verbatim, warnings, the final
status, summary counts and the paths involved, each with the line numbers where
the detail is. Its answer is checked before it is used: every path and
`file:line` position it cites must occur in the original, a line number it cites
must be one of the original's lines unless the original itself names it, and
the whole condensed result must come to at most half of the original's tokens. An answer that fails is not used and the
result is forwarded whole. "The original" is the result as the modules before
this one left it, so with the truncator on, the file holds the truncated text.

#### Stored originals

Originals go in `tool-results`, under the llm-fw directory (`~/.llm-fw`, or
`LLM_FW_DIR`), one file per distinct original, named by its SHA-256 so that the
name says nothing of the content. The folder is limited to the running user; if
that cannot be done, nothing is stored and results are forwarded whole. Nothing
logs a path, a hash or any output. The agent opens a file with its own tool, so
it needs read access to that folder.

Files that no request carried for `retentionHours` are swept every 30 minutes,
whether or not the module is on. The **Delete stored originals** button on the
module card (`POST /api/modules/tool-result-shunt/purge`) empties the folder at
once, outcome files included.

#### Remembered outcomes

Each result is decided the first time a request carries it, keyed by its tool
name and exact text, and the decision is kept: in memory, and in an outcome file
(`<key>.outcome`, in the same folder) that holds the condensed text or only the
reason the result stays whole. So the same history is forwarded byte for byte
on every turn, and again after llm-fw restarts, with no new worker call. A
result the worker failed on, or whose answer failed a check, stays whole in the
same way: repairing the worker does not change a history already sent. The
outcome file can quote the output, since the worker's facts do.

Every request that carries a result touches its files, so the sweep spares what
is in use. The retention counts from the last request that carried a result, not
from the first. A result that no request carried for `retentionHours` (24 hours
by default) lapses: its files are swept and its decision is forgotten, and when
it turns up again it is decided again, so a condensation can come back worded
differently. After a restart, a result whose outcome file is gone is decided
again in the same way. This is the one place the module's output depends on
time (see [What every module guarantees](#what-every-module-guarantees)). The
number of remembered results has no limit, because forgetting one early would
reword it.

A file gone while a request carries the result (the sweep, an operator purge, a
hand deletion) is written back at the same path, identical, before the request
is forwarded, and the text the conversation already holds does not change. When
an original cannot be written back (the folder is full or cannot be written),
the remembered text is still forwarded, one warning is logged however many
requests follow, and the card's **Stored originals missing** counts each
request; the agent is then pointed at a file that is not there. An outcome file
that cannot be written back only logs its warning, and after a restart that
result is decided again.

#### After DLP and detection

Every other module runs before DLP and detection, so both scan what is
forwarded. This one runs after them, on the body that would be forwarded,
because it needs to know what they made of each result. Two things follow.

- The condensed text is never scanned. It is the worker's list of facts about a
  result the scanners had already passed.
- A result is condensed only if both scanned it and flagged nothing in it. One
  they flagged, or did not reach (a scan cut short, or no record of a scan), is
  forwarded whole, is never sent to the worker, has no original stored, and
  stays whole for as long as requests carry it, even when a later request no
  longer flags it.

A result condensed earlier goes whole from the first request on which detection
or DLP flags it. Its stored original is deleted, its outcome file says only that
it was flagged, and the conversation's history changes once, at that request,
with the consequences under
[Changing a module in the middle of a conversation](#changing-a-module-in-the-middle-of-a-conversation).
Forwarding a worker's summary of a flagged result would pass it on unscanned.

#### Settings changed mid-conversation

For a client that resends its history, switching the module on or off, or
changing `tools`, `minLines`, `minChars` or `maxInputChars`, changes which
results of a running conversation are condensed. The next request condenses what
the new settings make eligible and forwards whole again what they no longer do,
and with the module off every result is whole. That changes how the earlier
turns are sent, with the consequences described under
[Changing a module in the middle of a conversation](#changing-a-module-in-the-middle-of-a-conversation).
Changing `workerUrl` or `workerModel` does not reword a result already decided,
only results not seen yet. Turned back on within `retentionHours`, the module
returns the wording it had. Start a new conversation after changing these
settings.

#### Worker context window

The worker has to read the whole result, so its context window must hold the
largest result sent to it, and Ollama cuts a longer input without saying so. The
module compares the prompt tokens the worker reports with what it sent. When
the worker read less than 80% of it, its answer came from part of the output, so
the result is forwarded whole, one warning gives both counts and says to raise
the window, and the tokens the worker did read are counted. A reply that reports
no `usage.prompt_tokens` is treated the same way.

Ollama's window defaults to 4k, 32k or 256k tokens by VRAM (`ollama serve
--help`). Set it when starting the server and check it after a first request
(both verified on 2026-10-17 with Ollama 0.31.1):

```bash
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
curl -s http://127.0.0.1:11434/api/ps    # context_length
```

Then set `maxInputChars` to what the window holds. `qwen2.5` read about 0.45
tokens per character of numbered test output (13,566 tokens for 30,349
characters), so a 32,768-token window holds results up to roughly 55,000
characters with room for the answer, and `maxInputChars` should be about that.
The default of `200000` assumes a window to match: with a smaller one, every
result between the two sizes costs a worker call and is forwarded whole. A
result above `maxInputChars` is forwarded whole without a call.

#### Failing open, observe mode and the card

No worker, a worker that is not local, one that errors or does not answer
within `waitMs`, an answer that fails a check, a folder that is full or cannot
be written: in each case the result is forwarded whole and one warning names the
problem, never the output. Under observe mode the module asks the worker (which
costs it tokens), writes no files and forwards the original body, and the card
counts what it would have saved.

The card shows the results condensed, the results forwarded whole by reason,
original and condensed tokens (the estimate above), the tokens the worker read
and wrote, the average and longest wait the module added to a request (a request
that only carried results already decided, with no file to write back, adds no
sample), the stored originals and their size, and the stored originals missing.

How much it saves is measured over recorded Claude Code sessions by
`npm run eval:shunt:replay`, which needs a worker and writes nothing under
`~/.llm-fw`. The first measurement is
[below](#measured-on-recorded-sessions).

#### Measured on recorded sessions

Measured on 2026-10-18 with the replay stage over every Claude Code transcript
on one developer's machine: 1,805 files holding 64,510 tool results (435 of the
files are under project directories named for this repository). The worker was
`qwen2.5:3b` under Ollama 0.31.1 with a 32,768-token window, on a laptop with an
Intel Arc A370M (4 GB, Vulkan, part of the model on the GPU) and a 12-core CPU.
Tokens are counted with the `Xenova/gpt-4o` tokenizer on LF-normalised text, not
with the estimate above. The stage runs the module's own checks, then detection
and DLP with the shipped settings, then the worker and the stored original, and
counts **only the results the module would condense**. A result that passed the
tool, size and argument checks but that detection or DLP flagged is left out of
every token figure and counted as flagged; none was left unscanned. The stage
counts a result each time it appears, including the copies that resumed sessions
repeat, while the worker answered each distinct text once (215 texts).

The comparison stage, a billed run of the agent with and without the module, was
not run. What the agent does after it gets a condensed result, such as reading
the stored original back, is therefore not measured.

How the figures are counted:

- **Tokens avoided**: the original's tokens less those of the condensed result
  as forwarded, summed over the condensed results, counted once, as new input.
- **Bill-weighted**: the same difference times `1.25 + 0.1 x R`, where R is the
  number of distinct assistant messages after the result and before the
  conversation was next compacted, less the first, which reads it as new input:
  one cache write, then a cache read per later turn. The weight averaged 9.2
  (7.6 with file reads) per token avoided.
- **Worker tokens**: what the worker read and wrote, answers that were rejected
  included. They are local compute and cost nothing on the bill; the net
  subtracts them to show what the worker spends against what it saves.

| | File reads left out (the default) | File reads included |
| --- | --- | --- |
| Passed the tool, size and argument checks | 233 | 435 |
| Flagged by detection or DLP, left out | 78 | 198 |
| Sent to the worker | 155 | 237 |
| Condensed | 125 (81%) | 194 (82%) |
| Rejected by the checks, forwarded whole | 30 | 43 |
| Worker failed, forwarded whole | 0 | 0 |
| Original tokens of the results sent | 901,315 | 1,458,535 |
| Tokens of the condensed results as forwarded | 30,178 | 44,431 |
| Tokens avoided | 699,549 | 1,149,719 |
| Share of all 64,510 results' tokens | 2.14% | 3.52% |
| Bill-weighted saving | 6,402,208 | 8,722,381 |
| Worker tokens, read plus written | 1,154,393 + 24,871 | 1,955,779 + 41,102 |
| Net tokens avoided (less worker tokens) | -479,715 | -847,162 |
| Net bill-weighted (less worker tokens) | 5,222,944 | 6,725,500 |

Read them with these limits in mind:

- **Counted in tokens alone the module is a loss.** The worker read 1.7 tokens
  for every token it spared the model (its input carries a line number on every
  line, and it counts with its own tokenizer), so both net token figures are
  negative. The bill-weighted net is positive because a condensed result is
  spared on every later turn, not once.
- **The saving is small.** Against the same transcripts' own usage records
  (assistant messages counted once per file: input at 1, cache writes at 1.25,
  cache reads at 0.1, 1.82 billion units), the bill-weighted saving is 0.35% of
  the input bill (0.29% net of the worker tokens), and 0.48% (0.37% net) with
  file reads. Only 0.36% of the tool results (0.67% with file reads) passed the
  tool, size and argument checks, so the module has little to work on in this
  traffic.
- **On this machine at the shipped settings the module saves nothing.** None of
  the 215 worker calls finished within the default `waitMs` of 15,000 ms: the
  fastest took 17 s, the median 47 s, the slowest 19 minutes (a reply that ran
  to the answer cap). Every result would have been forwarded whole as a worker
  failure; that follows from the call times and was not run separately. The
  figures above come from a run with the wait raised to 15 minutes, and show what
  a worker that answers within the limit would save. A worker that holds the
  model on a faster GPU, or a larger `waitMs`, which makes a request that carries
  new results wait up to that long, are the two ways to get there.
- **The worker's answers were rejected one time in five** (30 of 155). A
  rejected result is forwarded whole and costs the worker tokens for nothing.
  The condensed results averaged 241 tokens as forwarded against 5,838 for their
  originals (95.9% smaller).
- **Retention was not measured with the sample size it needs.** The stage checks
  that the lines a rule-based extractor takes for facts (failing test names,
  error messages, the final status, summary counts) appear verbatim in the
  condensed text. It found any in only 19 of the 218 distinct shell outputs that
  passed the checks, so the labelled subset is 10 condensed results (20 with file
  reads), under the 50 the success criterion asks for. Of those results' fact
  lines, none appeared verbatim. That does not show the facts were lost, since
  the worker paraphrases (an exit-code line comes back as "exit code 0"), and
  some of what the extractor takes for a fact is not one (a source line that
  looks like an error call). It does mean nothing here shows that the condensed
  text keeps the failures.
- **One developer, one worker.** A third of the results that passed the checks
  (78 of 233) were flagged and left out, 45% with file reads; whether the
  sessions in this repository, where test output can hold attack strings,
  explain that was not measured. One result in each report, whose DLP redaction
  left the request body unparseable, was counted as flagged. Another worker
  model, or traffic with fewer flagged results, would give other numbers.

The second run reused the first run's worker answers (a caching proxy in front
of Ollama answered each distinct request once) and recomputed everything else.
The results seen, the results eligible and their original tokens agreed exactly
between the two, and with file reads left out the whole report matched. With
file reads included they differed by one worker call that took 19 minutes: the
first run's wait of 15 minutes ended it as a worker failure, the second took its
answer, which was rejected. The figures above are the second run's. The answers
themselves are one sample from a model at temperature 0; they were not asked for
twice. `~/.llm-fw` was listed before and after and did not change.

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
