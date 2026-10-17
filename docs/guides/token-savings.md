[llm-fw](../../README.md) > [Documentation](../README.md) > Token savings

# Token savings

The firewall already sits on every LLM request, so it can also make requests
cheaper before they leave. Each technique below is a separate gateway module
with its own switch, its own KPIs on the dashboard's **Modules** tab, and its
own live events. All of them are off by default, because each one changes what
the provider receives.

## Turning a module on and off

Every module has a `modules.<key>.enabled` config key. Each can be flipped live,
without a restart, in any of these ways:

- the toggle on its card in the dashboard's **Modules** tab, which also
  persists the change to `~/.llm-fw/config.json`,
- `POST /api/modules` with `{"id": "<module id>", "enabled": true}`,
- editing `config.json`, which is hot-reloaded,
- the `LLM_FW_*_ENABLED` environment variable, at start-up.

`modules.enabled: false` (or `LLM_FW_MODULES_ENABLED=false`) turns off the
whole pipeline.

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

## Modules

In pipeline order, which is also the order of the cards:

| Module id | Config key | Rewrites |
| --- | --- | --- |
| `history-window` | `modules.historyWindow` | drops the oldest turns of a long conversation (lossy) |
| `ansi-strip` | `modules.ansiStrip` | terminal escape codes in tool output and prompts |
| `progress-collapse` | `modules.progressCollapse` | progress-bar frames in tool output and prompts |
| `repeat-collapse` | `modules.repeatCollapse` | runs of identical lines in tool output |
| `blob-elide` | `modules.blobElide` | long base64 and hex runs in tool output |
| `token-pruner` | `modules.tokenPruner` | prompt and system text |
| `tool-result-pruner` | `modules.toolResultPruner` | tool output |
| `tool-result-dedup` | `modules.toolResultDedup` | repeated tool output |
| `tool-result-truncate` | `modules.toolResultTruncate` | the middle of oversized tool output (lossy) |
| `tool-definition-pruner` | `modules.toolDefinitionPruner` | tool and parameter descriptions |
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
**Lossy**: the model never sees what is cut. A build log, a full test run or a
large file read can be tens of thousands of tokens, re-sent on every later
turn, while the head and tail usually carry the command, the error and the
summary.

| Option | Default | Does |
| --- | --- | --- |
| `headLines` | `200` | Lines kept from the start of a tool result longer than `headLines + tailLines`. |
| `tailLines` | `100` | Lines kept from the end. The middle becomes `[llm-fw: N lines elided]`. Both `0` turns the line cut off. |
| `maxChars` | `40000` | After the line cut, a result still longer than this keeps two thirds of it from the head and one third from the tail, with `[llm-fw: N characters elided]` between; this catches one huge line, such as minified code. `0` is off. |

The cut depends only on the result itself, so the same history is sent the
same way every turn. An agent that reads a long file and then rewrites the
whole file would write the marker into it; prefer the agent's own paging
(read with an offset) where it has one, or keep this off for editing agents.

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
- **Input served from cache**: cache reads over all input.

It reads Anthropic `usage` (JSON and the `message_start` / `message_delta`
stream events), OpenAI chat `usage` (a stream carries it only when the client
sends `stream_options.include_usage`), the Responses API `response.completed`
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
in whole steps, and the cut then moves forward to the first plain user turn,
so a tool call is never separated from its result. The first kept turn starts
with `[llm-fw: N earlier messages omitted]`. Works on OpenAI chat, Anthropic
and Gemini conversations. Requests whose history lives on the server are left
alone: a Responses API request with `previous_response_id`, and an Anthropic
thread continuation (`thread.type` is `continue`), whose messages are all new.

What it costs:

- **One prompt-cache miss per step.** Between steps the kept history is a
  stable prefix and the cache keeps matching; a larger `step` means fewer
  misses and more turns kept on average.
- **Thinking blocks in the kept turns are removed.** Dropping turns changes
  the conversation every later thinking block was signed against, and models
  with preserved thinking refuse a block whose prefix changed. The model loses
  that reasoning. Anthropic's server-side compaction
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
