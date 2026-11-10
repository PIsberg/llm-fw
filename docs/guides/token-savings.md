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

A thread does not last the whole session. Claude Code 2.1.318 sends the full
history again when a user prompt arrives, or a queued message is injected,
and continues from there through that prompt's tool calls. Matched on
2026-11-05 between the History window's events and the session transcripts:
cuts at 18:21:49 and 18:38:29 UTC fell one second after a prompt and on a
queued message, and the billed input of the calls that followed fell from
132,782 to 56,318 and from 117,853 to 61,400 tokens. So the history window
does act on Claude Code through the proxy, once per prompt, and the server
runs that prompt's whole tool loop on the history it kept.

### Changing a module in the middle of a conversation

For a client that resends history, turning a rewriting module on or off, or
changing one of its options, changes how the earlier turns of a running
conversation are sent. The next request misses the prompt cache once. On
models with preserved thinking, every thinking block is bound to the turns
before it, and accounts the provider enforces that check for (Anthropic
accounts created on or after 2026-08-31) would get a 400 for the rest of the
conversation: "The block is bound to a different conversation."

So whenever the module pipeline runs on an Anthropic request from a Claude 5
model whose history carries thinking blocks, llm-fw sets
`thinking.block_binding.prefix_mismatch_behavior` to `"drop_block"` and adds
the `thinking-binding-controls-2026-08-01` beta, unless the client set the
field itself. A block an edit invalidated is then dropped instead of the
request being refused; the model loses that reasoning for the turn. Probed
on 2026-10-19 with a captured Claude Code request (Claude Haiku 5.5, three
thinking turns): an earlier tool result edited with `"error"`, which is how
an enforced account behaves, answered 400; the same edit with
`"drop_block"` answered 200 with the later blocks dropped; an unedited
request with `"drop_block"` dropped nothing and read the prompt cache as
before (48,329 tokens, nothing written). On an older account, which is not
enforced, the field opts the request into the check, so after an edit those
blocks are dropped where the model would otherwise still have received
them. Switching the Token Economy itself off is not covered: the pipeline,
and so the field, stops with it. A server-side thread is not affected: its
earlier turns are never sent again.

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
skipping `ctx_read` as well keeps 29%.

Measured again on 2026-10-19 with file reads left whole (the default), on
the output the truncator still cuts: Claude Code 2.1.303 with Claude Haiku
5.5 at effort `high` through a relay running the module at its defaults,
three tasks on a clone of this repository, two rounds, arm order swapped.
Two tasks ran 16 commands with large output each (`git log -p -n 6`,
`grep -rn`) and asked for a fact from the top of every output; one ran
`git log --format='%h %s' -n 500` and asked for a commit in the elided
middle.

| Task, round | Off | Truncator on |
| --- | --- | --- |
| git log, 1 | $0.125, 17 turns | $0.275, 36 turns |
| git log, 2 | $0.155, 25 turns | $0.100, 17 turns |
| grep, 1 | $0.105, 17 turns | $0.098, 17 turns |
| grep, 2 | $0.104, 17 turns | $0.239, 29 turns |
| middle of a 500-line log, both | $0.006 and $0.002 | $0.003 and $0.002 |
| **All** | **$0.497, 82 turns** | **$0.716, 106 turns** |

Every answer was right in both arms. The module removed 169,788 tokens by
its own count, but cache reads rose from 735,855 to 2,162,617 tokens with the
extra turns, and the total cost went up 44%. The spread between rounds is
wide (17 to 36 turns on one task), so read this as no saving shown, not as a
measured loss of 44%. On this sample, with file reads whole, the truncator
does not lower the bill.

### Where the input bill goes

Over 30 days of one developer's Claude Code transcripts (1,843 transcript
files, 59,184 API calls, mostly Claude Opus 5.5; usage as the API reported
it, cache reads at 0.1 and one-hour cache writes at 2 times input):

| Part of the input bill | Share |
| --- | --- |
| Cache reads | 81.7% |
| One-hour cache writes | 12.4% |
| Five-minute cache writes | 5.9% |
| Uncached input | 0.0% |

The mean prompt was 271,537 tokens. Almost the whole bill is the history
read back from the cache on every call, so what moves it is how much stays
in the history, not how large any one result is when it arrives.

### What the modules saved on real traffic

The Modules tab's summary adds up, over every request, the estimated tokens
each module kept out of that request. It does not price them, and a client
that resends history is counted again for the same saving on every request.
On 2026-11-05 it read 15.1% saved, 481,943 of the 530,503 tokens from the
History window. Priced the way the provider bills, the modules measured below
saved 0.47 to 0.65% of the bill. The lean-ctx compressor, which runs an
external binary, was not replayed.

Measured over 14 days of one developer's Claude Code transcripts (141
sessions, 16,698 API calls, the live install's module settings). The bill
is the usage the API reported for each call: cache reads at 0.1, one-hour
writes at 2, output at 5 times input.

| Module | Removed | Share of the 14-day bill |
| --- | --- | --- |
| History window | 14 cuts in 10 sessions: 2.20M input-equivalent tokens of cache reads avoided, 0.69M of cache writes added | 0.23% net; 7.5% of the 10 sessions it cut |
| Tool result modules (pruners, collapsers, blob elider, deduplicator, truncator with file reads skipped) | 131,807 of 8.9M tool-result tokens (1.48%), nearly all from `Bash` | 0.24 to 0.42% |

How each row was counted. A History window cut shows in the usage as billed
input falling while the message count grows past 100; each dropped token is
counted as a cache read avoided on every later call until the next drop or
an hour's gap, and the extra cache write on the cut call is charged against
it. The tool-result row runs every recorded tool result through the built
modules; a removed token saves its one-hour write and a read on every later
call in the session. The range is the billed-per-estimated-token ratio, 1.0
to the 1.76 the Usage Meter measured. Neither row includes what a change
does to the agent's behaviour, such as re-reading what was removed, which
only a billed A/B shows (see the truncator above).

What the modules do not touch is larger. Tool Usage counted 33 of the 53
tools Claude Code offered as never called, 15,506 estimated tokens on every
request. At the mean prompt of 287k tokens over these 14 days, that is 4 to
7% of the bill, read from the cache on every call. See
[Tool filter](#tool-filter) for what dropping them costs, and for
`shortenTools`, which on a later 30 days modelled a net 1.51% of the bill
together with the drop, against 0.38% for the drop alone.

### Clearing old thinking: measured, not offered

Thinking is 66% of Claude Opus 5.5's output tokens (output less the visible
text and tool calls, as characters / 4), and it is sent back: on 268 Opus
5.5 calls that appended under 300 tokens of tool output and user text, the
prompt grew by 104% of the previous response's whole output, thinking
included. Claude Code asks the API to keep all of it
(`{"type": "clear_thinking_20251015", "keep": "all"}` in every request).

Replacing that with `keep: {"type": "thinking_turns", "value": 1}` was
built, probed and measured on 2026-10-19, and is not offered:

- The API counts a turn per user prompt, not per call. Over one prompt's 14
  calls, 10 of them with thinking, the server cleared nothing; on the next
  prompt it cleared those 10 blocks (1,750 tokens), and that call wrote
  42,913 tokens to the cache. Thinking in the tool loop in progress always
  stays, and each new prompt pays one cache rewrite.
- Modelled on that basis over the transcripts above, keeping one turn would
  save at most 4.1% of the input bill net of the rewrites (9.7% of reads
  saved, 5.6% rewritten); keeping two or three turns is a loss. This counts
  nothing for the model reasoning again.
- Billed, on three conversations of three prompts each (Claude Code 2.1.303,
  Claude Haiku 5.5 at effort `high`, two rounds, arm order swapped), it was
  a loss:

| Follow-up prompts, where clearing acts | Keep all | Keep one |
| --- | --- | --- |
| Cost | $0.0245 | $0.0589 |
| Cache writes | 25,774 tokens | 171,477 tokens |
| Output tokens | 9,352 | 16,968 |
| Calls | 20 | 25 |

Answers were correct 17 of 18 times keeping all and 18 of 18 keeping one;
the one miss misread which files the question meant. Each follow-up paid
for its rewrite, too few calls followed to earn it back, and output rose by
81%, which the model above leaves out. Long interactive sessions, where the
modelled ceiling comes from, were not measured.

### Clearing old tool results: measured, removed

A `tool-result-clear` module once added Anthropic's server-side
`clear_tool_uses_20250919` edit (trigger 100,000 input tokens, keep the last
10 tool calls, clear at least 20,000 tokens, file readers excluded), so the
server replaced old tool results with a placeholder before the model read
them. Verified against the API on 2026-10-18: `keep: 1` on a request with
three tool results cleared the two oldest (9,331 tokens), and the next
identical request read the edited prompt from the cache.

Modelled over 14 days of transcripts (cache read 0.1, one-hour write 2), it
would have saved 13.1% of the bill, 10.9% with file reads left alone. Both
billed comparisons went the other way, so the module was removed:

- File reads (2026-10-18, Haiku 5.5, three read-heavy tasks, two rounds):
  with reads cleared, the agent read the files again ("Many tool results were
  cleared during the session, so I re-read them"), and the task across 22
  files took 57 to 75 turns and $0.367 to 0.585 against 23 to 25 turns and
  $0.134 to 0.143 off. With reads excluded, nothing was left to clear and
  the cost matched off.
- Shell and search output (2026-10-19, Haiku 5.5 at effort `high`, the
  defaults above): two tasks each ran 16 commands with large output
  (`git log -p -n 6` on 16 files, about 385,000 characters; `grep -rn` for
  16 patterns, about 411,000), then asked for one fact from the top of every
  output. Two rounds, arm order swapped:

| Both tasks, both rounds | Off | On |
| --- | --- | --- |
| Cost | $0.62 | $2.81 |
| The same tokens at Claude Opus 5.5 prices | $5.42 | $22.67 |
| Turns | 76 | 169 |
| Cache writes | 549,022 tokens | 2,447,570 tokens |
| Output tokens | 35,310 | 105,195 |
| Facts correct | 63 of 64 | 64 of 64 |

The agent ran cleared commands again (each `git log` four or five times in
one run). And each output, about 25,000 tokens, was larger than the 20,000
minimum, so as the window of 10 slid one result per call, the server cleared
again and rewrote the cache on 12 of 14 calls. A session whose old output is
never needed again was not measured.

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
| `tool-filter` | `modules.toolFilter` | removes the tools you name from the tool list, or cuts their definitions to a stub; removes the skills you name from Claude Code's skill listing |
| `tool-definition-pruner` | `modules.toolDefinitionPruner` | tool and parameter descriptions |
| `tool-usage` | `modules.toolUsage` | nothing; lists the offered tools that never or rarely get called, and the listed skills never invoked (on by default) |
| `stream-usage` | `modules.streamUsage` | asks OpenAI-style chat streams to report usage; saves nothing, makes the meter complete |
| `cache-control` | `modules.cacheControl` | adds Anthropic prompt-cache markers, and moves the one-hour entries of clients you name to five minutes; saves cost, not tokens |
| `response-cache` | `modules.responseCache` | nothing; answers a repeated request from a stored response |
| `usage-meter` | `modules.usageMeter` | nothing; reads responses (on by default) |
| `prompt-monitor` | `modules.promptMonitor` | nothing; keeps the prompts users type for the Prompts tab (off by default) |

### Tool result pruner

`modules.toolResultPruner.enabled` (`LLM_FW_TOOL_RESULT_PRUNER_ENABLED`).
Tool output (Anthropic `tool_result` blocks, OpenAI `tool` messages, Responses
API `function_call_output`) is usually most of an agent's input. Four
techniques, each with its own switch:

| Option | Default | Does |
| --- | --- | --- |
| `minifyJson` | `true` | A tool result that is a JSON object or array loses the whitespace outside its strings. Lexical, not parse-and-print: every number and string stays byte for byte, so `12345678901234567890` is not rounded. |
| `trimTrailing` | `true` | Spaces and tabs at the end of each line go. |
| `collapseSpaceRuns` | `false` | Runs of two or more spaces after a line's indentation become one. Saves the most on column-aligned command output (`ls -l`, `kubectl get`, `docker ps`). |
| `collapseStackFrames` | `false` | A run of two or more contiguous library or runtime stack frames (`node_modules/`, `node:internal/`) becomes `[llm-fw: N internal/library stack frames elided]`. Application frames stay whole. Lossy: the agent gets the elided frames back only by rerunning the command. 0.06% of tool-result tokens over a 30-day replay of Claude Code transcripts. |

What to watch for: an agent quotes a file read verbatim in its next edit. With
`trimTrailing`, an edit whose quoted text spans a line that ends in spaces in
the file no longer matches. With `collapseSpaceRuns`, any edit of a line with
aligned spaces misses, which is why it is off. A single tab, such as the one
after a line number in Claude Code's file reads, is never collapsed. With
`collapseStackFrames`, a failure inside a dependency loses the frames that
locate it, which is why it is off too.

One more rewrite runs whenever the module is on, with no switch of its own,
because it drops nothing: two or more contiguous `file:line:content` lines for
the same file (`grep -rn`, `rg`, `tsc`) are grouped under one `<file>:` header,
each match kept as `  line:content`. Every match stays. The prefix must look
like a file path, a directory separator or a file extension and no whitespace,
so log lines that start with an ISO timestamp (`2026-10-06T16:57:25Z`) or the
tab-separated lines of `gh run view --log` are left as they are.

### Tool result deduplicator

`modules.toolResultDedup.enabled` (`LLM_FW_TOOL_RESULT_DEDUP_ENABLED`), option
`minLength` (default `200` characters). Agents reread the same file and rerun
the same command, and every copy stays in the history they resend. A tool
result identical to an earlier one in the same request becomes
`[llm-fw: identical to the earlier tool result <id>]`, naming the first copy
by its tool call id (or `#n`, its position, when the format carries no id).
The first copy always stays, and which copy is kept depends only on what came
before it, so a growing conversation is rewritten the same way on every turn.

Detection runs after the modules, so it can withhold the first copy a pointer
names, and the model then reads only the withhold notice there. When that
happens, every pointer to the withheld copy gets its text back and the request
is scanned again, so each copy is judged on its own surface and path: a `Read`
from a `trustedPaths` root passes where the same text through a shell command
was withheld, and a second untrusted copy is withheld too. A withheld copy is
also dropped from what a thread continuation remembers. A copy named by
position (`#n`) is found by counting the request's tool results the way the
pointers were numbered, from the start of the thread.

A client that keeps the conversation on the server and sends only the new
messages (`thread` with `type: "continue"` and `previous_message_id`, or the
Responses API's `previous_response_id`) gets the same pointers across turns:
the module remembers what each request contained and chains it to the id the
response carries. The chain survives the modules and the DLP redaction that run
after it. It holds 256 threads and 512 results per thread, oldest dropped
first, in memory only, so it starts empty after a restart. A thread belongs to
the tenant and provider host that started it: a request naming another
tenant's response id starts empty.

A `<system-reminder>...</system-reminder>` block identical to one that already
appeared in a user turn, the client's own text, becomes
`[llm-fw: identical system-reminder omitted]`, in a later prompt or a tool
result, whatever its length. A reminder that first appears inside a tool
result or an assistant turn is never the copy that counts: tool output and
the model's own text are untrusted, and a planted or echoed copy must not
make the genuine one disappear when the client sends it.

Measured live on 2026-10-23, together with the pruner: Claude Code with
Sonnet through a spare-port instance, both modules off then on, 3 runs per arm
on each of two tasks against a small Node fixture, $0.46 in all, every run
fixing the bug. Compared between runs with the same number of turns, billed
prompt tokens (uncached input, cache reads and cache writes) fell by 0.55%
(70,854 to 70,464) on a find-and-fix task with grep output, and by 0.11% to
0.57% on a task that rereads files and reruns commands. On that second task
the deduplicator removed 3.2% of tool-result tokens and the pruner 6.2%. The
ceiling is low because most of each request is the system prompt, the tool
definitions and the model's own turns, which neither module touches.

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
a call whose `command` argument (a string, or an argv array), or `cmd` for
Codex's `exec_command`, has a word
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
| `tools` | `["Bash", "PowerShell", "shell", "shell_command", "exec_command", "run_shell_command"]` | Shell tools whose results are sent, matched like `skipTools` above: Claude Code's `Bash` and `PowerShell`, Codex CLI's `shell_command`, `exec_command` and `shell`, Gemini CLI's `run_shell_command`. The command is the call's `command` argument, or `cmd` for `exec_command`: a string, or an argv array (`["bash", "-lc", "npm test"]`, the `shell` shape in Codex's docs), which is read as one line, so a file read behind `bash -lc` stays whole. In 32 recorded Codex sessions every shell call was `shell_command` (891) or `exec_command` (10), and file reads went through PowerShell's `Get-Content`. |
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

`modules.toolFilter.enabled` (`LLM_FW_TOOL_FILTER_ENABLED`), `modules.toolFilter.dropTools`,
`modules.toolFilter.shortenTools`, `modules.toolFilter.shortenTo`,
`modules.toolFilter.dropSkills`.
An agent sends a definition for every tool it has on every request, used or
not, and the provider bills the whole list each time (as a cache read once it
is cached). This removes the tools named in `dropTools`: an exact name, or a
pattern where `*` matches any run of characters, over the whole name
(`mcp__axiom__*`, `Cron*`). Both lists are empty by default, so turning the
module on changes nothing until you name tools; which tools a client never
needs is your call, and the model cannot call a tool it is not shown.

What stays even when it is named:

- a tool the conversation has already called, or that `tool_choice` (Gemini:
  `allowedFunctionNames`) forces, since the provider refuses a request that
  references a tool it was not given;
- a tool that carries a `cache_control` breakpoint, which the client placed
  (it can still be shortened: the breakpoint stays on the stub);
- every tool, when all of them would go;
- server tools without a name (`{"type": "web_search"}`), and tools a
  conversation adds as `tool_addition` blocks, which are left to the client.

A tool kept because the history calls it changes the tool list on the turn the
call first appears, which is one cache write, the same as switching the module.
Name only tools a client does not call, and that turn never comes.

**Shortening instead of dropping.** `shortenTools` takes the same names and
patterns, for a tool a client calls now and then: one you cannot drop, because
the model cannot call a tool it is not shown. A tool named there stays on the
list as a stub. Its description, and every parameter description in its schema,
is cut to its first paragraph and to at most `shortenTo` characters (200 by
default, cut at a word), and the tool's description ends with
`[llm-fw: description shortened]`. The name, the schema's structure, types,
enums and `required` lists are untouched, so a call the model makes from the
stub is one the client can run. A definition with nothing long enough to cut
is left as it is, and a tool named in both lists is dropped.

Once a conversation has called a shortened tool (or `tool_choice` forces it),
that conversation is sent the whole definition again, so the model works from
the full instructions from its second call on. That turn changes the front of
the prompt, and the provider writes the whole prompt to its cache again: at 2
times the input price for a one-hour write where a read costs 0.1, about 19
calls' worth of reading the same prompt. A stub therefore pays only for a tool
whose definition is large and whose first calls are few. A client that
continues a server-side thread (Claude Code through the proxy) sends its tool
list when the thread starts and not with the calls, so there the stub stays
until the next user prompt: that prompt starts a new thread with the whole
history and the tool list again, and the definition goes back to whole there.
Captured from Claude Code 2.1.322 on 2026-11-10: the first prompt's two
requests were a thread start with 14 tools and a continuation with none, and
the next prompt's thread start carried all 8 messages so far and the 14 tools.
The model works from the stub for the rest of the prompt it first called the
tool in.

Modelled on 30 days of one developer's Claude Code transcripts (2026-11-09:
52,618 API calls, 44,102 of them with the tool list recorded, mean billed
prompt 260,120 tokens; the built module run over each recorded list with the
tools that conversation had called so far; cache reads at 0.1, one-hour writes
at 2, output at 5 times input). Definitions were 16,684 estimated tokens per
call:

| Tool Filter setting | Definitions per call | Read back less | Rewrites | Net, share of the bill |
| --- | --- | --- | --- | --- |
| `dropTools`: the 58 tools never called | 15,087 | 0.38% | 0 | 0.38% |
| `shortenTools`: `Artifact` (8,308 tokens, 4 calls) and `SendFeedback` (1,233 tokens, 2 calls) | 11,644 | 1.20% | 3, costing 0.07% | 1.13% |
| Both | 10,046 (39.8% less) | 1.58% | 3, costing 0.07% | 1.51% |
| `shortenTools`: all 15 tools of 300 tokens or more called under once in 200 calls | 11,059 | 1.34% | 238, costing 5.34% | a loss of 4.00% |

The last row is why the choice of tools matters: `AskUserQuestion`, `Skill`
and `PushNotification` are each under 1 call in 200, but dozens of
conversations call them once, and each first call rewrote a prompt of a
quarter of a million tokens. The [Tool usage](#tool-usage) card applies the
break-even for you. The lists were picked from the same 30 days they are
scored on, and the model counts nothing for how the model behaves with a stub
in place of a full description (whether it reaches for the tool less often,
or makes a worse first call), which only a billed comparison on real work
would show.

Checked live on 2026-11-09 (Claude Code 2.1.321 in print mode, Claude Haiku
5.5, through the gateway in enforce mode; print mode offers 15 tools, 9,619
estimated tokens). With `PowerShell`, `Workflow`, `Agent` and `ScheduleWakeup`
shortened, none of them needed by the task, the API billed 23,795 tokens of
cached prefix per call against 30,408 with the filter off, 6,613 fewer, where
the module counted 4,184; both arms read a file and answered correctly in two
calls. With `Read` shortened as well, the model called `Read` from its stub,
answered correctly, and the request after the call carried `Read` whole (five
definitions shortened on the first request, four on the second).

Measured on one captured Claude Code 2.1.302 request (44 tools, 21,798 tokens of
definitions, sent on every request by a client pointed at a custom base URL):
naming 27 tools, 26 that 30 days of this developer's transcripts never called
and `Workflow`, called once (DesignSync, the cron and worktree tools, LSP,
NotebookEdit, two MCP servers), cut the
definitions to 11,347 tokens, 48%. Its effect on the bill is not measured; the
tool list is a cache read on most turns, so expect a tenth of that in cost
between cache writes, and the full amount on each write.

**Skills.** Claude Code tells the model which skills it can invoke in a
listing it writes itself: the sentence "The following skills are available
for use with the Skill tool:", then one `- name: description` entry per
installed skill. It is sent with every conversation and read back from the
cache on every call, like the tool list. `dropSkills` removes the entries you
name (same names and `*` patterns: `speckit-*`, `anthropic-skills:*`), with
the lines that continue them, and nothing else in that text.

What a dropped skill loses is the model's knowledge that it exists, so the
model will not invoke it on its own. A person can still run it by name
(`/deslop`): the client loads a skill a person asks for whatever the listing
says. Unlike a dropped tool, a dropped skill never comes back mid-conversation,
also after it was invoked, so no turn pays a cache write for it.

The listing is recognised by that sentence, in a system message or in a
`<system-reminder>` of a user message (where older versions of Claude Code
put it). The same sentence in text a person typed, a tool returned or the
model wrote is content and is left alone. A listing in a shape this does not
know (anything but entries between the sentence and the next blank line) is
left alone too, as is one whose every skill is named: to hide all skills,
drop the `Skill` tool.

The sentence has four wordings, all of which are matched. Claude Code builds
it from a template (read from the 2.1.321 bundle): a listing sent later in a
conversation says the skills "are also available" and that the list "adds to
the skills listed earlier in this conversation and is not the full list", and
a client that loads skills from scripts says "available; a script loads one
with `await tools.Skill(...)`" where the others say "available for use with
the Skill tool". On 30 days of one developer's transcripts, 23 of 1,105
listings were later ones, 0.3% of what the listings cost; the script wording
did not occur.

The wording is Claude Code's to change. If a release rewords it, the entries
stop being removed and nothing else happens, so two things say so:

- `npm run client-tags -- --check` reads a release's bundle and fails when a
  part of the sentence is gone. The weekly Client Tags workflow runs it
  against the newest release, and on a pull request that touches the Tool
  Filter.
- The card shows a line when `dropSkills` is set, 20 or more requests offered
  the `Skill` tool, and none carried a listing in a wording this version
  knows.

Modelled on 30 days of one developer's Claude Code transcripts (2026-11-10:
52,970 API calls, 1,006 recorded listings; the built module run over each
listing with every skill no session invoked through the Skill tool named in
`dropSkills`). 121 skills were listed and 29 invoked. Removing the other 92
took the listing from 5,276 to 1,381 estimated tokens, 73.8% less, and that
is 1.58% of the bill: a listing is written to the cache once and read on
every later call of its session, here on 51,033 of the 52,970 calls. The
list was picked from the same 30 days it is scored on, and nothing is counted
for a skill the model would have invoked had it seen it.

Checked live on 2026-11-10 (Claude Code 2.1.321 in print mode with the
developer's own settings, Claude Haiku 5.5, through the gateway in enforce
mode, each arm twice): with 52 of the 85 listed skills dropped, the API
billed a prompt of 34,383 tokens against 40,320 with the filter off, 5,937
fewer, where the module counted 3,805. Asked how many skills starting with
`speckit` it could invoke and whether `deslop` was on the list, the model
answered "7 yes" with the filter off and "0 yes" with it on, both times.

### Tool usage

`modules.toolUsage.enabled` (`LLM_FW_TOOL_USAGE_ENABLED`), on by default
because it changes nothing. It answers the question the tool filter leaves to
you: which tools does this client never call? It records every tool a request
offers, with the token estimate of its definition, and every call it sees, from
the request history and from responses (a request that continues a server-side
thread, as Claude Code does through the proxy, carries the results but not the
calls). Its card lists the tools no call has named yet, largest first, with
their combined tokens per request: names you can copy into
`modules.toolFilter.dropTools`. It also counts the calls of each tool, and
lists the ones called so rarely that a stub pays, for
`modules.toolFilter.shortenTools`. It runs after the tool filter and the
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

The same click offers the rarely called tools to `shortenTools`, and the
button then reads **Drop N never-called and shorten M rarely called tools in
the Tool Filter** (or **Shorten these M rarely called tools** when nothing is
left to drop). A tool is on that list when

    calls of the tool x 19,000,000 <= its definition's tokens x the calls it was offered on

which is the break-even from [Tool filter](#tool-filter) with a margin of 4:
every call of the tool is counted as a first call that rewrites a
250,000-token prompt, and the stub has to save four times that. "Offered on"
is the share of requests whose tool list held the tool, applied to all calls,
so a tool a client loads on demand counts only for the requests that carried
it. On the 30 days of transcripts above the rule picks `Artifact` and
`SendFeedback` and leaves out the 13 other tools called under once in 200
calls, which is the difference between the second and the last row of that
table. Per-tool counts start with this version: a `tool-usage.json` written
before it says only that a tool was called, so those tools are never offered
for shortening until the module's stats are reset.

Skills are counted the same way. The card reads Claude Code's skill listing
from each request (see **Skills** under [Tool filter](#tool-filter)), with
the token estimate of every entry, and counts each invocation the model makes
through the `Skill` tool, from the request history and from responses. It
lists the skills never invoked, largest first, and after the same 1,000 calls
the click also offers them to `modules.toolFilter.dropSkills` (**Drop these N
never-invoked skills in the Tool Filter**, or one button naming tools and
skills together). A skill a person runs by name does not go through the
`Skill` tool and is not counted; dropping it from the listing does not stop
that. On the 30 days of transcripts above, 92 of 121 listed skills were never
invoked by the model.

Why it matters: across 14 days of one developer's Claude Code transcripts
(34,209 assistant turns), cache reads were 78.5% of the bill by list-price
weights, and the tool list is part of that prefix on every turn. A captured
request carried 21,798 tokens of definitions, an estimated 6% of the bill at that
turn count (21,798 x 34,209 turns x 0.1, not measured per request), while those
sessions called 44 distinct tools in total. A tool that
has not been called yet may still be needed; the list is evidence, not a
verdict.

`llm-fw start` keeps the list across restarts in `<LLM_FW_DIR>/tool-usage.json`
(tool and skill names, their token estimates, how many requests offered each
tool and how many calls each tool and skill got; no request content),
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

### Stream usage reporter

`modules.streamUsage.enabled` (`LLM_FW_STREAM_USAGE_ENABLED`). An OpenAI
chat completions stream reports its token usage only when the client asks
with `stream_options: {"include_usage": true}`, and most clients do not, so
the usage meter cannot meter those streams. This sets it on every streaming
`/chat/completions` request that does not already, on any host that serves
that path (OpenAI, Azure OpenAI, Groq, Together), keeping the client's other
stream options. Saves nothing by itself; it makes the Usage Meter's totals
complete for OpenAI-style clients.

What the provider then sends: one more chunk at the end of the stream, with an
empty `choices` array and the `usage` object, which is how the API documents
the option. When the client did not ask for it, the proxy and the gateway
drop that chunk from the stream the client receives, after the Usage Meter
has read it, so the client gets the stream it asked for. A client that set
`include_usage` itself gets the chunk as before. No message text is touched,
so the prompt cache is unaffected.

Checked on 2026-10-19 with openai-node 7.39.0 and openai-python 3.35.1 against
a local stand-in that streams the way the API does with the option set
(content chunks, then the usage chunk, then `[DONE]`):

| Client code | openai-node | openai-python |
| --- | --- | --- |
| Iterating the stream, reading `choices[0]?.delta` / checking `if c.choices` | works, usage read from the last chunk | works, usage read from the last chunk |
| The stream helper (`finalChatCompletion()` / `get_final_completion()`) | works, `usage` filled in | works, `usage` filled in |
| Iterating and reading `choices[0].delta` unchecked | throws `TypeError` on the last chunk | raises `IndexError` on the last chunk |

So the SDKs parse the chunk, but client code written for a stream that never
carries it can crash on it, and that idiom is common. That is why the chunk
is dropped for a client that did not ask for it. The filter acts only on a
`text/event-stream` response without a content-encoding; a compressed
stream passes through as it came, chunk included. No agent client that
streams chat completions was available to check; Codex CLI uses the
Responses API, which this module does not touch.

### Prompt cache marker

`modules.cacheControl.enabled` (`LLM_FW_CACHE_CONTROL_ENABLED`),
`modules.cacheControl.ttl`, `cacheSystem`, `shortTtlClients`, `shortTtlScope`. Anthropic
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
own, so this changes nothing for it unless you name it in `shortTtlClients`
(below); the card counts both cases. Writing an
entry costs more than an uncached read (1.25 times the input price for five
minutes), so a one-off request that is never repeated pays more, and a
prefix shorter than the model's minimum (512 to 4,096 tokens) is not cached
at all. Check the Usage Meter's cache reads to see whether it pays. Under
observe mode the original body goes upstream, and the card counts the request
under **Would mark** instead.

**Five-minute entries for runs that never idle.** `shortTtlClients` and
`shortTtlScope` are the one case where the module changes markers a client
placed. Claude Code asks for a one-hour entry on every breakpoint. Such an
entry costs 2 times the input price to write where a five-minute one costs
1.25, and the extra buys one thing: the conversation can idle for more than
five minutes and still read its cache. An interactive session needs that. A
run that never idles (print mode, `claude -p`; an agent in a CI job) pays it
for nothing.

| Option | Default | Does |
| --- | --- | --- |
| `shortTtlClients` | `[]` | Names of clients, each matched anywhere in the request's `User-Agent`, in any case. A matching request's one-hour breakpoints become five-minute ones. Claude Code's print mode sends `claude-cli/<version> (external, sdk-cli)`, so `sdk-cli` names it and leaves an interactive session (`(external, cli)`) alone. |
| `shortTtlScope` | `messages` | `messages`: only the conversation's own breakpoints (on message blocks, on tool results, and the top-level automatic one); the tools and system prompt keep their one-hour entry, which separate runs share. `all`: those too. |

The model is sent the same text either way; only the TTL the cache entry is
written with changes, and a later call reads a five-minute entry exactly as
it reads a one-hour one (each read renews it). The API wants one-hour
breakpoints before five-minute ones, which both scopes keep.

Measured on 30 days of one developer's Claude Code transcripts (2026-11-09,
52,734 API calls; one-hour writes at 2, five-minute writes at 1.25, cache
reads at 0.1, output at 5 times input). The one-hour premium, the difference
between the two write prices, was 4.99% of the whole bill:

| Sessions | One-hour premium, share of the whole bill | What five-minute entries would have added |
| --- | --- | --- |
| Interactive (267 conversations, 42,548 calls; 205 idled five minutes or more at least once) | 4.14% | rewrites worth 30.71% of the bill: every idle gap writes the whole prompt again. Leave these alone. |
| Print mode (577 runs, 2,231 calls; none idled five minutes between calls) | 0.86%, which is 27.2% of what those runs cost | nothing inside a run. With `all`, 25 of the 577 runs started 5 to 60 minutes after the previous one and would have written the shared prefix again, 0.04% of the bill. |
| Subagents and Python SDK sessions | 0 | They already ask for five-minute entries. |

Checked live on 2026-11-09 (Claude Code 2.1.321 in print mode, Claude Haiku
5.5, through the gateway in enforce mode, a task of three calls, the shared
prefix already cached, each arm twice):

| | Off | `messages` | Off | `all` |
| --- | --- | --- | --- | --- |
| Written to the cache | 14,064 tokens, one-hour | 14,091, five-minute | 14,159, one-hour | 14,187, five-minute |
| Read from the cache | 62,123 | 62,150 | 62,218 | 62,225 |
| Cost, as Claude Code reported it | $0.00364 | $0.00260 (28.5% less) | $0.00370 | $0.00266 (28.2% less) |

Every arm answered correctly in three calls, and the calls after the first
read the five-minute entries the earlier ones wrote. With `all`, the request
also read the tools and system prompt entry an earlier run had written with
a one-hour TTL.

What it can cost: if one step of a named client's run takes five minutes or
more (a long build or test command), the next call finds its entries expired
and writes the conversation again at 1.25 times input where it would have
read it at 0.1. With `messages` that is the conversation only; with `all`
the tools and system prompt as well, and also whenever two runs start more
than five minutes apart. Name only clients whose steps are short, and prefer
`messages` unless runs come in bursts or more than an hour apart. Whether a
client is in print mode is read from its `User-Agent`, which a client can set
to anything; this is a billing choice for traffic you run yourself, not a
control. The card counts requests and breakpoints moved, and, under observe
mode, the requests it would have moved. Which clients to name need not be a
guess: the [Usage meter](#usage-meter) counts, per client, how many
conversations idled and what five-minute entries would have changed, and
offers the ones that qualify.

Measured and not offered: five-minute entries only inside a tool loop. The
idea was to keep the one-hour entry on the first call of each prompt a person
types, which then covers everything before it, and to write the calls of the
tool loop that follows at the five-minute price. Modelled on the same 30
days (265 interactive conversations, 42,716 calls, 75.9% of their one-hour
writes inside tool loops), it would have saved 3.00% of the bill and lost
5.72%: the entries written inside a loop had expired at 773 prompts typed 5
to 60 minutes after the previous call and at 598 gaps of that length in the
middle of a loop (a long command, a scheduled wake-up, a permission prompt),
and each time the loop's content was written again. A net loss of 2.72%, so
`shortTtlClients` stays a choice per client and does not look inside a
conversation.

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
scans; a stored stream gets the audit scans a live stream gets, and in block
mode is refused with the block status when it carries an exfil URL. So a
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

**Cache entries by client.** The card also keeps, per client, the evidence
for the Prompt Cache Marker's
[`shortTtlClients`](#prompt-cache-marker): five-minute cache entries pay for a
client whose conversations never idle five minutes, and cost a rewrite each
time one does. For every client that names its conversation (Claude Code
sends `x-claude-code-session-id`) it shows one line:

    claude-cli (sdk-cli): 577 conversations, 0 idled 5 minutes or more, 21,183,696 one-hour cache-write tokens, five-minute entries would have cost 15,887,772 input tokens less

A client is Claude Code with its mode (the part of its `User-Agent` in
brackets: `cli` is an interactive session, `sdk-cli` print mode), or any
other client's product name. The last figure is 0.75 times the tokens written
at the one-hour price (2 against 1.25 times input), less 1.15 times the
tokens read from the cache by calls that followed 5 to 60 idle minutes, which
five-minute entries would have had to write again (1.25 against 0.1). A gap
of an hour or more costs both lifetimes the same and is left out. It is in
input tokens, so multiply by your input price.

After 50 conversations of a client whose saving is at least four times that
cost, the card offers **Use five-minute cache entries for sdk-cli**, which
adds the name to `modules.cacheControl.shortTtlClients` and switches the
Prompt Cache Marker on; like the Tool Usage action it is armed on the first
click and sent on the second. For a client already named there, with the Prompt Cache Marker switched on, the line
says how many calls followed five idle minutes, which is how often its
entries had expired: if that number grows, the client does idle, and the
name should come out again.

`llm-fw start` keeps these totals across restarts in
`<LLM_FW_DIR>/usage-clients.json` (client names and counts; no request
content, no session ids), written at most every 5 seconds and on a graceful
stop. The conversations themselves are held in memory only, the 5,000 most
recent, so a restart in the middle of a conversation counts it twice.
Resetting the module's stats empties the file; `uninstall --purge` deletes
it. A client whose name is not plain letters, digits, dots, dashes and
underscores is not reported: a `User-Agent` is whatever the client sends,
and the name can end up in your config.

### Prompt monitor

`modules.promptMonitor.enabled` (`LLM_FW_PROMPT_MONITOR_ENABLED`), **off by
default**: it stores what people type, so you opt in. It saves no tokens and
changes no request. It feeds the dashboard's **Prompts** tab, which lists the
prompts newest first and lets you search and filter them:

- **Search**: every word you type must appear in the prompt, in any case.
- **Filters**: target host, model, client (the address a prompt came from on the
  proxy, or the tenant on the gateway) and a time range (last hour, 24 hours,
  7 days). They combine with the search.
- **Clear** forgets everything held and leaves the monitor on.

What it keeps:

- The newest user message of each request, and only when nothing follows it. An
  agent resends the whole conversation after every tool result, so a prompt
  followed by a tool result or an assistant turn was already stored when it was
  first sent. A prompt typed twice in a row is stored twice, and so is a client
  retry of the same request.
  Tool results, system text and assistant turns are never kept, and neither is
  a `<system-reminder>` part an agent appends to the user turn.
- Anthropic, OpenAI chat, the Responses API and Gemini request shapes.
- The text after the DLP redactor has run on it with the default detectors,
  whatever `dlp.mode` is, so a key pasted into a prompt is not kept in the clear.
  The redactor misses what no detector matches: treat the list as sensitive.
- At most `maxChars` characters of each prompt (default 4000; the row says how
  long the prompt was) and the newest `maxEntries` prompts (default 500).

Opting in and out is live: the **Monitoring** switch on the Prompts tab, the
module card, `POST /api/modules` and a config hot reload all take effect on the
next request. **Switching it off drops every held prompt**, and so does
stopping the process: nothing is written to disk. It sits under Token Economy
like every module, so with Token Economy off nothing is recorded. It records
requests on the proxy and the gateway, before detection runs, so it also holds
a prompt that was then refused; look in Events for what happened to it.

`GET /api/prompts` returns the same list as JSON (`q`, `target`, `model`,
`session`, `since`, `until`, `limit` up to 500, `offset`), and
`POST /api/prompts/clear` empties it. Both sit behind the dashboard's auth; the
clear is also same-origin only. Anyone who can open the dashboard can read the
prompts, so do not bind it beyond loopback without a token.

### History window

`modules.historyWindow.enabled` (`LLM_FW_HISTORY_WINDOW_ENABLED`). **Lossy**:
the model no longer sees the turns it drops.

| Option | Default | Does |
| --- | --- | --- |
| `maxMessages` | `100` | Turns kept, not counting leading system and developer messages, the top-level system prompt and the first user turn, which always stay. At least `2`. |
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

The first turn stays when it is a plain user message, byte for byte, ahead of
the marker. Claude Code puts CLAUDE.md, the rules files, the memory index and
the user's request there. Cut with the rest, it left an agent past the window
without the repository's rules or the task it was given. It precedes every
cut, so it stays in the cached prefix when
the cut moves. On Gemini, which wants user and model turns to alternate, its
parts go at the start of the first kept turn instead of a turn of their own.

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
trailing whitespace, condenses Markdown table cell padding and separator dashes
(preserving alignment colons), and minifies multiline JSON embedded in the
text, keeping every number and string byte for byte. Leading indentation and
fenced code are kept.

It rewrites user, assistant and system text in OpenAI chat, the OpenAI
Responses API (`input`, `instructions`), Anthropic (`messages`, `system`) and
Gemini (`contents`, `systemInstruction`). It never touches tool output: an
agent quotes a file read verbatim in its next edit, so a collapsed run of
spaces there makes the edit miss. It never touches thinking blocks either.

An unfenced string literal with aligned spaces is altered, which is why it is
opt-in.
