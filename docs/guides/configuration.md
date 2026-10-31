[llm-fw](../../README.md) > [Documentation](../README.md) > Configuration reference

# Configuration reference

Where config is read from, the full key reference, and what the firewall does when a stage cannot run.

## Configuration

Settings are read from four layers, lowest precedence first:

1. the built-in defaults;
2. a JSON file named by `LLM_FW_CONFIG`, if set;
3. `<LLM_FW_DIR>/config.json`, default `~/.llm-fw/config.json`, which `setup`,
   `setup-judge` and the dashboard's Settings view write;
4. `LLM_FW_*` environment variables.

**The working directory is not searched.** Earlier versions read
`.llm-fw.json`, `.llm-fwrc*`, `llm-fw.config.js` or a `"llm-fw"` key in
`package.json` from whatever directory llm-fw was started in, so running it
inside a cloned repository let that repository change the firewall's settings
or run code. A file of that name in the working directory is now ignored, with
a warning that names it. To keep using one, point at it explicitly:

```bash
LLM_FW_CONFIG=/path/to/.llm-fw.json llm-fw start
```

`LLM_FW_CONFIG` must name a `.json` file; a missing or unparsable file stops
startup rather than falling back to defaults. JavaScript and YAML config files
are not supported. Like `LLM_FW_DIR`, it is read from the process environment
only, so no config file can redirect it.

A config file, for example `~/.llm-fw/config.json`:

```json
{
  "proxy": {
    "mode": "proxy",
    "port": 8080
  },
  "detection": {
    "heuristicBlockThreshold": 50,
    "embeddingBlockThreshold": 0.86,
    "judgeEnabled": false,
    "judgeModel": "qwen2.5:3b",
    "judgeBlock": false
  },
  "dashboard": {
    "port": 7731
  }
}
```

All fields are optional — defaults are shown above. Full key reference below and in [ARCHITECTURE.md](../ARCHITECTURE.md).

**Environment variable overrides:**

```bash
LLM_FW_PROXY_PORT=9090
LLM_FW_EMBEDDING_BLOCK_THRESHOLD=0.80
LLM_FW_EMBEDDING_MAX_CHUNKS=24
LLM_FW_JUDGE_ENABLED=true
```

**Scan cost on long prompts.** `detection.embeddingMaxChunks` (default `24`)
bounds how much of one piece of text the embedding stage encodes. Above it the
text is sampled evenly rather than truncated, and the heuristic stage still
reads every byte. Raising it costs latency roughly linearly; `0` removes the
bound entirely, which is how a 1 MB prompt used to take 423 s. See
[detection-stages.md](detection-stages.md#cost-on-long-prompts).

`detection.embeddingMaxPassesPerRequest` (default `128`,
`LLM_FW_EMBEDDING_MAX_PASSES`) bounds the same stage per request, across every
text the request carries: 16 distinct 40 KB messages in one body took 26 s to
scan before it, about 1.6 s each. Prompts and tool results are read newest
first, alternating, so a spent budget skips old history rather than the turn
that just arrived, and chunks served from the cache cost nothing. When the
budget runs out the request is not refused: it warns with stage
`scan-budget`, and the heuristic stage has still read every byte. Hot-reloads.
`0` removes the bound.

**Classifier surface scoping.** The opt-in trained classifier
(`detection.classifier`) can be limited to specific scan surfaces via
`detection.classifier.surfaces` (also `LLM_FW_CLASSIFIER_SURFACES`,
comma-separated). The default list is `prompt, memory, tool_result, document`:
the trusted `system` and `tool_definition` surfaces are excluded because the
model false-positives on developer-authored instruction text at every
threshold. Scoping it to only the untrusted data surfaces turns it into an
indirect-injection detector with no false-positive cost on user prompts:

```json
{
  "detection": {
    "classifier": { "enabled": true, "surfaces": ["tool_result", "document"] },
    "surfaces": { "tool_result": { "classifierBlockThreshold": 0.999 } }
  }
}
```

`classifierBlockThreshold` under `detection.surfaces` raises the block bar on
that surface only; the second line is optional and trades recall for precision
on benign tool output. Measured numbers for both settings are in
[BENCHMARK.md](../BENCHMARK.md).

**What the classifier does not score.** The model reads any instruction to
the model as an injection, including the ones an agent writes into its own
turns, so the agent's own sentences are left out of its input (the heuristic
and embedding stages still read them). In a user turn of a request Claude
Code sent (user agent `claude-cli`), each `<system-reminder>` block that opens
with one of Claude Code's own sentences (the commit attribution lines, "the
user hasn't heard from you", the line above a CLAUDE.md, the git status, a
background-task notification) has those sentences dropped; what the block
carries is still scored, each `Contents of <file>` body on its own, so a
cloned repository's CLAUDE.md and the agent's memory files are read by the
classifier as by every other stage. A reminder block that opens with
anything else is scored whole, and the text the user typed beside the blocks
is scored on its own; the verdict is the highest part. Claude Code's
slash-command and `<session>` envelopes are scored for what they carry, and
its fixed tool results such as `(Bash completed with no output)` are not
scored. The same blocks from any other client, or on any other surface, are
scored as they are. llm-fw's own withhold notices (`[llm-fw withheld this
...]`) are never scored, on any surface. Measured on the real model: the
harness sentences score 97% to 100% on their own, this repository's CLAUDE.md
body 0.00%, a rules file 0.00%, the memory index 0.05%, an attack typed
beside a reminder 100%.

**Trusted project roots.** `detection.surfaces.tool_result.trustedPaths` (also
`LLM_FW_TRUSTED_PATHS`, comma-separated) lists absolute directories whose files
you vouch for. A file-read tool result from under one of them, or a shell tool
result whose command was one plain `cat`, `head`, `tail`, `sed -n` or
`Get-Content` of one file there, warns instead of blocking when only a wording
stage objects; other shell output, fetches and anything under `node_modules` or
`vendor` there do not count. Empty by default, applied
live. See [Tuning: trust file reads from your own projects](tuning.md#trust-file-reads-from-your-own-projects).

**What a blocked tool result does.** `detection.surfaces.tool_result.onBlock`
(also `LLM_FW_TOOL_RESULT_ON_BLOCK`) is `withhold` by default: the tool result
that blocked is replaced with a fixed notice, `[llm-fw withheld this tool
output: it matched the <stage> rule. Its content was not passed on to the
model.]`, and the rest of the request is forwarded. The event is recorded as
blocked with `withheld: true` (shown as WITHHELD), once per text. `refuse`
refuses the whole request, as before. An agent resends its history on every
turn, so under `refuse` one false positive in a tool result refuses every later
request of the session; replaying 7 days of real Claude Code sessions, the
sessions that would have ended that way went from 32 to 10 of 245 under
`withhold`. Either way the model never reads the flagged text. Blocks on the
newest prompt, a system prompt, a tool definition or the request itself still
refuse, and so does a tool result the proxy cannot find in the body to replace,
or a 17th one in the same request. Realtime WebSocket sessions always refuse.
Applied live.

**What a blocked earlier prompt does.** `detection.surfaces.prompt.olderTurns`
(also `LLM_FW_PROMPT_OLDER_TURNS`) is `withhold` by default: a user message
that blocks but is not the newest one is replaced with `[llm-fw withheld this
earlier message: it matched the <stage> rule. Its content was not passed on to
the model.]` and the rest is forwarded, recorded once as WITHHELD. The newest
message still refuses, so a blocked message is refused once, on the turn it
was sent. The newest message is the last user turn, never the system prompt,
which some providers place after the turns (fixed in #528). Claude Code puts skill bodies and compaction summaries in user turns
and resends them, so before this one such block refused the rest of the
session (#476). The newest message is forwarded exactly as typed or the request
is refused: if withholding would change it, it refuses. `refuse` keeps
refusing every request that still carries the message. Applied live.

**The Surfaces group in the dashboard.** The Settings view shows and edits
the per-surface settings above: `tool_result.onBlock`, `prompt.olderTurns`,
`prompt.wordingAction`, and the heuristic and classifier block thresholds of
the `tool_result` and `document` surfaces. A threshold the surface does not
override shows the global value it falls back to; setting it there writes only
that surface's key to `<LLM_FW_DIR>/config.json` and leaves the global one and
`trustedPaths` as they were. Applied live, like every other setting in the view.

**Model cache and first start.** The first run downloads the ONNX weights from
HuggingFace, which is why `start` can sit on `Loading embedding model...` for a
while. Point `LLM_FW_MODEL_DIR` at a persistent path to download once and reuse
it across restarts, containers and CI:

```bash
LLM_FW_MODEL_DIR=/var/lib/llm-fw/models
LLM_FW_MODEL_LOAD_TIMEOUT_MS=600000   # 0 waits indefinitely
```

Without a shared cache each fresh state directory re-downloads. While a load is
in flight llm-fw logs a heartbeat every 30s; if it exceeds the timeout the ML
stage is disabled and the firewall starts anyway, with the heuristic, DLP, MCP,
URL and DoS stages still running — the same outcome as any other model-load
failure, so an unreachable HuggingFace degrades detection rather than blocking
startup.

**Audio transcription.** OpenAI's audio models (`input_audio` parts) and Gemini
(`inlineData` with an `audio/*` type) accept speech in an ordinary chat
request, and will follow an instruction spoken in the clip. By default such a
clip is opaque: `nonText.mode` decides whether it is audited or refused.
`nonText.transcribe: true` (or `LLM_FW_NONTEXT_TRANSCRIBE=true`) transcribes WAV
and AIFF clips locally with Whisper (`Xenova/whisper-tiny`, about 40 MB, cached in
`LLM_FW_MODEL_DIR` beside the embedding model) and scans the transcript like a
document, so a spoken injection can block. Only uncompressed PCM is decoded:
WAV, and AIFF (or AIFC marked `NONE` or `sowt`), which Gemini accepts as
`audio/aiff`. MP3, AAC, Ogg and FLAC clips stay opaque by decision: decoding
them would need a third-party codec dependency, and the pure-WASM AAC decoder
considered is GPL-2.0 (#257). Block mode is the way to refuse them. At most three clips per
request, and the first 120 s of each, are transcribed. A transcribed clip
still counts as opaque media, so block
mode refuses it whatever it says: a transcript adds a reading, it does not
certify the audio.

**Realtime API and Gemini Live (WebSocket).** The forward proxy and the
[gateway](gateway-mode.md) relay OpenAI Realtime sessions
(`wss://api.openai.com/v1/realtime`) and Gemini Live sessions
(`wss://generativelanguage.googleapis.com/ws/…BidiGenerateContent`) and inspect
the client's messages. A turn's
`input_audio_buffer.append` chunks (PCM16, 24 kHz) are held when the client
commits them (`input_audio_buffer.commit`, or `response.create` with audio
buffered) and scanned like an `input_audio` part, so `nonText.transcribe` and
`nonText.mode` apply as above; user text, whether added with
`conversation.item.create` or passed as `response.create` input, is scanned as
a prompt and `function_call_output` as a tool result (honouring
`detection.surfaces.tool_result.onBlock`, so under `'withhold'` its output is
replaced with a notice and the session stays open). `session.update` and
`response.create` instructions and `system`-role items are developer-authored
and pass, like a system prompt. Every text event except audio chunks goes
through DLP as a request body would (`redact` rewrites the event). A binary
message, or text that is not a JSON event, ends the session: it cannot be
inspected. So does a message larger than `proxy.maxBodyBytes`, counted across
all of its fragments, with close code 1009 and a `dos` event: before that cap
a client could send continuation frames without ever finishing the message
and grow one buffer until the process ran out of memory. With server-side voice
activity detection the client never commits, so every 15 s of buffered audio is
also scanned while it streams; a block there ends the session, but that audio
has already reached the provider. A block sends the client an `error` event
with `code: "llm_fw_blocked"` and closes the socket with 1008. Each scan is
capped at 120 s of audio.

Gemini Live maps onto the same scan points. `realtimeInput` audio (PCM16 at the
rate its `audio/pcm;rate=` mime type names, 16 kHz by default) is buffered and
scanned when the turn ends (`activityEnd` or `audioStreamEnd`), and every 15 s
while it streams under automatic activity detection. `realtimeInput` text and
the user turns of `clientContent` are scanned as a prompt (model turns are
history and pass), `toolResponse` function responses as tool results, and video
frames as images, so `nonText.mode` applies to them. `setup` is
developer-authored and passes, but DLP reads it. A message that carries only
media skips DLP, whose patterns would otherwise run over base64. Gemini clients
read errors from the close frame, so a block closes the socket with 1008 and a
reason naming the event id, with no error event. Gemini's own server sends JSON
in binary frames, so a binary frame holding a JSON event is inspected; any
other binary frame still ends the session.

Under observe mode (deployment-wide, or a gateway tenant's) no session is
refused: blocks are recorded with `enforced: false`, DLP audits, and a message
the relay cannot read is forwarded and recorded. Other WebSocket paths answer
501 rather than being tunnelled unscanned. The Responses API over WebSocket
(`/v1/responses`, and chatgpt.com's `/backend-api/codex/responses` under
`proxy.inspectChatgptBackend`) answers 426 instead: Codex CLI opens it first
and switches to HTTP, which is inspected, at once on 426, where it retried a
501 five times, about 4.5 s per session.

**Trusted recipients for indirect injection.** The indirect-instruction
stage blocks a tool result that tells the agent to send data or money to an
address, which is how an injected email or web page exfiltrates. An inbox or
CRM agent also reads ordinary mail that says exactly that ("please send the Q3
numbers to finance@acme.com by Friday"), and the text cannot say whether the
recipient is yours. `indirectInstruction.trustedRecipientDomains` (or
`LLM_FW_INDIRECT_TRUSTED_RECIPIENT_DOMAINS=acme.com,acme.co.uk`) lists the
domains that are: an address on one of them, or on a subdomain, is no longer
an exfiltration target, and an instruction whose only object is such an
address does not fire. A lookalike (`finance@acme.com.evil.example`), any other
address, a URL or a sensitive object such as customer records in the same
clause still blocks. Empty by default, and hot-reloaded. It does not cover
payment instructions to an IBAN or account number: those name no domain.
List only domains you control. Never list a public mail provider: InjecAgent's
attacks send to a gmail.com address, and with `gmail.com` trusted the stage
catches 779 of its 1,054 instead of all of them. Any other destination in
the same text (an address, URL, account number or IBAN) cancels the
allowance, and an address counts as trusted only when whitespace or
ordinary punctuation surrounds it and its local part has no `%` or `!`
routing.

**Codex CLI signed in with ChatGPT.** Codex sends its turns to
`chatgpt.com/backend-api/codex/responses` when you sign in with a ChatGPT
account, and to `api.openai.com` only with an API key. llm-fw inspects the API
key route by default and tunnels `chatgpt.com` uninspected. Set
`proxy.inspectChatgptBackend: true` (or `LLM_FW_INSPECT_CHATGPT_BACKEND=true`)
to intercept it. Interception works per host, so this intercepts the whole of
`chatgpt.com`, including the ChatGPT web app in any browser that trusts the
llm-fw CA; only `/backend-api/codex/*` is inspected and every other request is
forwarded untouched, without detection, DLP or response scanning. Off by
default for that reason. A restart applies it. Proxy mode only: the gateway has
no ChatGPT route.

**Refusal status.** A request refused for its content (detection, DLP, MCP,
taint, a URL in the path, a response-side block) answers `422` on the proxy and
the gateway, with the same JSON body as before. It used to be `403`, which
Claude Code reports as "Failed to authenticate. API Error: 403" (#304);
measured against Claude Code 2.1.301, `422` gets "API Error: 422" and the
explanation, in one request, while `400` is retried once and `409` eight times.
`blockStatus: 403` (or `LLM_FW_BLOCK_STATUS=403`) restores the old status for a
client that branches on it. Refused CONNECT tunnels, authentication failures and
a tenant's disallowed provider keep their own codes. A tool result that blocks is
withheld rather than refused (see "What a blocked tool result does" above), so
that request is forwarded and answered normally.

**Token pruner (gateway modules).** `modules.tokenPruner.enabled: true` (or
`LLM_FW_TOKEN_PRUNER_ENABLED=true`, or the Settings toggle in the Cost & Abuse
group) rewrites the prompt text of every LLM request before it is scanned and
forwarded, on the proxy and the gateway: interior runs of spaces and tabs
become one space, runs of blank lines become one, trailing whitespace goes, and
multiline JSON embedded in the text is minified. Leading indentation and fenced
code are kept, and tool output is never touched. It is off by default because it changes what the provider
receives: an unfenced string literal with aligned spaces, for example, is
altered. Savings are estimated over the text it examined, with a run of
spaces counted as one token (see [Token savings](token-savings.md#how-savings-are-counted)), and shown live in the dashboard header and at `GET /api/modules`.
Under observe mode it runs as a dry run and forwards the original body.
`modules.enabled: false` (or `LLM_FW_MODULES_ENABLED=false`) turns off the
whole module pipeline: it is the switch of the **Token Economy** parent module
(see [Token savings](token-savings.md#token-economy-the-parent-switch)), and
each module keeps its own switch while it is off. Both keys are hot-reloaded. Every token-saving module,
with what it rewrites and what to watch for, is in
[Token savings](token-savings.md). The design is in
[SPEC-modules.md](../specs/SPEC-modules.md).

## Logging

Structured JSON to `stdout` for informational records and `stderr` for
problems, with one correlation id per request.

```bash
LLM_FW_LOG_LEVEL=info     # debug | info | warn | error | fatal (default info)
LLM_FW_LOG_FORMAT=json    # json | pretty (default: pretty on a terminal, json otherwise)
```

The default is right without configuring it: a person running `llm-fw start`
in a terminal gets prose, and the same binary in a container gets JSON a
collector can parse.

Both are read directly from the environment rather than through the config
object, and so are absent from the table below. Logging starts before
`loadConfig()` runs, and a logger that cannot report a configuration failure
because it is waiting on the configuration is no use.

**Request correlation.** The gateway gives every request an id, honouring an
inbound `x-request-id` when the caller sends one and minting a UUID otherwise,
and echoes it back in the `x-request-id` response header. Every log record
written while serving that request carries it, however deep in the detection
pipeline it was written. So "my request was blocked" has one token that appears
both in what the caller holds and in what the operator greps.

**What is never logged.** Prompt text, tool results, retrieved documents and
credentials. This is a firewall for traffic that contains exactly those things;
payload capture is a deliberate, separate decision behind
`audit.includePayloads`.

## Environment variable reference

Every `LLM_FW_*` variable, the config key it writes and its default. Applied after the config files, so an environment variable always wins. Two traps worth knowing before you read the table: booleans are strictly the string `true` (`1` and `yes` both mean false), and an empty value is ignored rather than treated as false.

`LLM_FW_GATEWAY_KEY_<SLUG>` is deliberately absent. Provider keys are read straight from the environment and never enter the config object, so the dashboard settings view cannot read them back out.

`LLM_FW_LEAN_CTX_BIN` is absent for a similar reason: it names the lean-ctx executable the [lean-ctx module](token-savings.md#lean-ctx-shell-output-compressor) starts, and is read from the process environment only, so a project config file in a cloned repository cannot choose a program for llm-fw to run.

<!-- CONFIG-REFERENCE-START -->

_112 variables, generated from `ENV_OVERRIDES` in `src/config/config.ts` by `npm run config:reference`. Do not edit by hand._

| Variable | Sets | Default |
| --- | --- | --- |
| `LLM_FW_ANSI_STRIP_ENABLED` | `modules.ansiStrip.enabled` | `false` |
| `LLM_FW_ASCII_SMUGGLING_ENABLED` | `asciiSmuggling.enabled` | `true` |
| `LLM_FW_AUDIT_ENABLED` | `audit.enabled` | `false` |
| `LLM_FW_AUDIT_FILE` | `audit.file` | _unset_ |
| `LLM_FW_AUDIT_PAYLOADS` | `audit.includePayloads` | `false` |
| `LLM_FW_AUDIT_WEBHOOK` | `audit.webhookUrl` | _unset_ |
| `LLM_FW_BLOB_ELIDE_ENABLED` | `modules.blobElide.enabled` | `false` |
| `LLM_FW_BLOCK_STATUS` | `blockStatus` | `422` |
| `LLM_FW_BYPASS` | `proxy.bypass` | `false` |
| `LLM_FW_CACHE_CONTROL_ENABLED` | `modules.cacheControl.enabled` | `false` |
| `LLM_FW_CLASSIFIER_ENABLED` | `detection.classifier.enabled` | `false` |
| `LLM_FW_CLASSIFIER_ESCALATE` | `detection.classifier.escalateThreshold` | `0.5` |
| `LLM_FW_CLASSIFIER_SURFACES` | `detection.classifier.surfaces` | `4 entries` |
| `LLM_FW_CLASSIFIER_THRESHOLD` | `detection.classifier.blockThreshold` | `0.9` |
| `LLM_FW_CRESCENDO_CROSS_REQUEST` | `crescendo.crossRequest` | `false` |
| `LLM_FW_CRESCENDO_ENABLED` | `crescendo.enabled` | `true` |
| `LLM_FW_CRESCENDO_MODE` | `crescendo.mode` | `block` |
| `LLM_FW_DASHBOARD_BIND` | `dashboard.bindHost` | `127.0.0.1` |
| `LLM_FW_DASHBOARD_PORT` | `dashboard.port` | `7731` |
| `LLM_FW_DASHBOARD_TOKEN` | `dashboard.authToken` | _unset_ |
| `LLM_FW_DLP_ENABLED` | `dlp.enabled` | `true` |
| `LLM_FW_DLP_MODE` | `dlp.mode` | `redact` |
| `LLM_FW_DOS_ENABLED` | `dos.enabled` | `true` |
| `LLM_FW_DOS_MAX_RPM` | `dos.maxRequestsPerMinute` | `60` |
| `LLM_FW_DOS_MAX_TOKENS_PER_SESSION` | `dos.maxTokensPerSession` | `50000000` |
| `LLM_FW_DOS_TOKEN_WINDOW_MS` | `dos.tokenBudgetWindowMs` | `3600000` |
| `LLM_FW_EMBEDDING_BLOCK_THRESHOLD` | `detection.embeddingBlockThreshold` | `0.86` |
| `LLM_FW_EMBEDDING_MARGIN` | `detection.embeddingMarginThreshold` | `0.02` |
| `LLM_FW_EMBEDDING_MAX_CHUNKS` | `detection.embeddingMaxChunks` | `24` |
| `LLM_FW_EMBEDDING_MAX_PASSES` | `detection.embeddingMaxPassesPerRequest` | `128` |
| `LLM_FW_EMBEDDING_WARN_THRESHOLD` | `detection.embeddingWarnThreshold` | `0.8` |
| `LLM_FW_ENFORCEMENT` | `enforcement` | _unset_ |
| `LLM_FW_EXTRA_TARGETS` | `extraTargets` | `0 entries` |
| `LLM_FW_FAIL_MODE` | `detection.failMode` | `closed` |
| `LLM_FW_GATEWAY_BIND` | `gateway.bindHost` | `127.0.0.1` |
| `LLM_FW_GATEWAY_DEFAULT_PROVIDER` | `gateway.defaultProvider` | `openai` |
| `LLM_FW_GATEWAY_ENABLED` | `gateway.enabled` | `false` |
| `LLM_FW_GATEWAY_PORT` | `gateway.port` | `8081` |
| `LLM_FW_GATEWAY_REQUIRE_AUTH` | `gateway.requireAuth` | _unset_ |
| `LLM_FW_GATEWAY_TLS_CERT` | `gateway.tls` | _unset_ |
| `LLM_FW_GATEWAY_TLS_KEY` | `gateway.tls` | _unset_ |
| `LLM_FW_GATEWAY_TOKEN` | `gateway.authToken` | _unset_ |
| `LLM_FW_HARMFUL_REQUEST_ENABLED` | `harmfulRequest.enabled` | `true` |
| `LLM_FW_HARMFUL_REQUEST_MODE` | `harmfulRequest.mode` | `block` |
| `LLM_FW_HISTORY_WINDOW_ENABLED` | `modules.historyWindow.enabled` | `false` |
| `LLM_FW_HOT_RELOAD` | `hotReload` | `true` |
| `LLM_FW_HTTPS_PORT` | `proxy.httpsPort` | `8443` |
| `LLM_FW_INDIRECT_INSTRUCTION_ENABLED` | `indirectInstruction.enabled` | `true` |
| `LLM_FW_INDIRECT_INSTRUCTION_MODE` | `indirectInstruction.mode` | `block` |
| `LLM_FW_INDIRECT_TRUSTED_RECIPIENT_DOMAINS` | `indirectInstruction.trustedRecipientDomains` | `0 entries` |
| `LLM_FW_INSPECT_CHATGPT_BACKEND` | `proxy.inspectChatgptBackend` | `false` |
| `LLM_FW_INTENT_MENTION_ENABLED` | `detection.intentMention` | `true` |
| `LLM_FW_INTERCEPT_DOMAINS` | `proxy.interceptDomains` | `2 entries` |
| `LLM_FW_JUDGE_BLOCK` | `detection.judgeBlock` | `false` |
| `LLM_FW_JUDGE_ENABLED` | `detection.judgeEnabled` | `false` |
| `LLM_FW_JUDGE_MODEL` | `detection.judgeModel` | `qwen2.5:3b` |
| `LLM_FW_JUDGE_UNLESS_BENIGN` | `detection.judgeUnlessBenign` | `false` |
| `LLM_FW_LEAN_CTX_ENABLED` | `modules.leanCtx.enabled` | `false` |
| `LLM_FW_MANYSHOT_ENABLED` | `manyShot.enabled` | `true` |
| `LLM_FW_MANYSHOT_MODE` | `manyShot.mode` | `block` |
| `LLM_FW_MAX_BODY_BYTES` | `proxy.maxBodyBytes` | `10485760` |
| `LLM_FW_MCP_ENABLED` | `mcp.enabled` | `true` |
| `LLM_FW_MCP_GUARDRAILS_ENABLED` | `mcp.guardrailsEnabled` | `true` |
| `LLM_FW_MEMORY_POISONING` | `memoryPoisoning.enabled` | `true` |
| `LLM_FW_MEMORY_POISONING_MODE` | `memoryPoisoning.mode` | `block` |
| `LLM_FW_METRICS_ENABLED` | `dashboard.metrics` | `true` |
| `LLM_FW_MODEL_LOAD_TIMEOUT_MS` | `detection.modelLoadTimeoutMs` | `600000` |
| `LLM_FW_MODULES_ENABLED` | `modules.enabled` | `true` |
| `LLM_FW_NONTEXT_ENABLED` | `nonText.enabled` | `true` |
| `LLM_FW_NONTEXT_MODE` | `nonText.mode` | `audit` |
| `LLM_FW_NONTEXT_OCR` | `nonText.ocr` | `false` |
| `LLM_FW_NONTEXT_TRANSCRIBE` | `nonText.transcribe` | `false` |
| `LLM_FW_OLLAMA_URL` | `detection.ollamaUrl` | `http://localhost:11434` |
| `LLM_FW_PROGRESS_COLLAPSE_ENABLED` | `modules.progressCollapse.enabled` | `false` |
| `LLM_FW_PROMPT_MONITOR_ENABLED` | `modules.promptMonitor.enabled` | `false` |
| `LLM_FW_PROMPT_OLDER_TURNS` | `detection.surfaces.prompt` |  |
| `LLM_FW_PROMPT_WORDING_ACTION` | `detection.surfaces.prompt` |  |
| `LLM_FW_PROXY_BIND` | `proxy.bindHost` | `127.0.0.1` |
| `LLM_FW_PROXY_MODE` | `proxy.mode` | `proxy` |
| `LLM_FW_PROXY_PORT` | `proxy.port` | `8080` |
| `LLM_FW_PROXY_REQUIRE_AUTH` | `proxy.requireAuth` | _unset_ |
| `LLM_FW_PROXY_TOKEN` | `proxy.authToken` | _unset_ |
| `LLM_FW_RAG_ENABLED` | `rag.enabled` | `true` |
| `LLM_FW_REPEAT_COLLAPSE_ENABLED` | `modules.repeatCollapse.enabled` | `false` |
| `LLM_FW_RESPONSE_CACHE_ENABLED` | `modules.responseCache.enabled` | `false` |
| `LLM_FW_RESPONSE_CANARY_ENABLED` | `responseScan.canary.enabled` | `false` |
| `LLM_FW_RESPONSE_CANARY_MODE` | `responseScan.canary.mode` | `block` |
| `LLM_FW_RESPONSE_CLASSIFIER_ENABLED` | `responseScan.classifier.enabled` | `false` |
| `LLM_FW_RESPONSE_CLASSIFIER_MODEL` | `responseScan.classifier.model` | _unset_ |
| `LLM_FW_RESPONSE_CLASSIFIER_THRESHOLD` | `responseScan.classifier.blockThreshold` | `0.9` |
| `LLM_FW_RESPONSE_HARM_ENABLED` | `responseScan.harmfulCompliance` | `true` |
| `LLM_FW_RESPONSE_SCAN_ENABLED` | `responseScan.enabled` | `true` |
| `LLM_FW_RESPONSE_SCAN_MODE` | `responseScan.mode` | `audit` |
| `LLM_FW_SCAN_SYSTEM_PROMPT` | `detection.scanSystemPrompt` | `false` |
| `LLM_FW_STREAM_USAGE_ENABLED` | `modules.streamUsage.enabled` | `false` |
| `LLM_FW_SUPPRESSIONS_ENABLED` | `detection.suppressions` | `true` |
| `LLM_FW_TAINT_ENABLED` | `taint.enabled` | `true` |
| `LLM_FW_TAINT_MODE` | `taint.mode` | `audit` |
| `LLM_FW_TOKEN_PRUNER_ENABLED` | `modules.tokenPruner.enabled` | `false` |
| `LLM_FW_TOOL_DEFINITION_PRUNER_ENABLED` | `modules.toolDefinitionPruner.enabled` | `false` |
| `LLM_FW_TOOL_FILTER_ENABLED` | `modules.toolFilter.enabled` | `false` |
| `LLM_FW_TOOL_RESULT_DEDUP_ENABLED` | `modules.toolResultDedup.enabled` | `false` |
| `LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD` | `detection.surfaces.tool_result` |  |
| `LLM_FW_TOOL_RESULT_ON_BLOCK` | `detection.surfaces.tool_result` |  |
| `LLM_FW_TOOL_RESULT_PRUNER_ENABLED` | `modules.toolResultPruner.enabled` | `false` |
| `LLM_FW_TOOL_RESULT_TRUNCATE_ENABLED` | `modules.toolResultTruncate.enabled` | `false` |
| `LLM_FW_TOOL_USAGE_ENABLED` | `modules.toolUsage.enabled` | `true` |
| `LLM_FW_TOOLUSE_SCAN_ENABLED` | `responseScan.toolUse.enabled` | `true` |
| `LLM_FW_TOOLUSE_SCAN_MODE` | `responseScan.toolUse.mode` | `audit` |
| `LLM_FW_TRUSTED_PATHS` | `detection.surfaces.tool_result` |  |
| `LLM_FW_USAGE_METER_ENABLED` | `modules.usageMeter.enabled` | `true` |
| `LLM_FW_WORKER_INFERENCE` | `detection.workerInference` | `false` |

<!-- CONFIG-REFERENCE-END -->

## Failure Semantics

What happens if the detection pipeline itself **fails** — a parser or stage throws on a request it should have scanned? That is a bug (the fuzz suite in `test/fuzz/` exists to keep it from happening), but the outcome must never be undefined behavior. `detection.failMode` makes it explicit:

- **`closed`** (default) — the request is **blocked** with the standard block response (`422`, or `blockStatus`) (`{ "error": "detection pipeline error — failing closed" }`) and a blocked `error` event appears on the dashboard. Nothing that could not be scanned reaches the provider. This matches the firewall's historical behavior, where a pipeline exception ended the request with an error response instead of forwarding it.
- **`open`** — the request is **forwarded upstream unscanned**, and a warned `error` audit event records the failure (including the stack) on the dashboard. Choose this when availability matters more than a scan gap during a firewall bug.

```json
{ "detection": { "failMode": "closed" } }
```

| Variable | Effect |
|----------|--------|
| `LLM_FW_FAIL_MODE` | `open` / `closed` — any other value is ignored |

Two neighboring escape hatches are unrelated to pipeline errors: `proxy.bypass` (`LLM_FW_BYPASS=true`) turns the whole proxy into a transparent no-inspection tunnel, and upstream/network failures still surface as `502` proxy errors as before.

### Every path, open or closed

`failMode` covers one failure. The table lists what each other path does when it cannot inspect something, read from the code (file in the last column), so the open paths are a decision on record rather than a surprise. **Closed** means the request or response does not go through; **open** means it goes through without that inspection.

| Situation | What happens | | Where |
| --- | --- | --- | --- |
| The detection pipeline throws | Refused with the block status, or forwarded with an `error` event under `failMode: open` | closed by default | `proxy.ts`, `gateway.ts` |
| A body sent to a parsed endpoint is not valid JSON, or repeats a key | Refused, stage `malformed-body` | closed | `pipeline.ts` |
| A JSON `POST` to an intercepted host on a path no parser reads | Forwarded, with an `unparsed` warn event | open | `proxy.ts` |
| A request `Content-Encoding` llm-fw cannot decode | `415`; a corrupt body `400`; one that expands past `proxy.maxBodyBytes` `413` | closed | `contentEncoding.ts` |
| A request body over `proxy.maxBodyBytes` (`0` means no cap, on every path that reads the setting) | `413` | closed | `proxy.ts`, `gateway.ts` |
| The embedding model failed to load | Stage 2 is skipped and the other stages run; the gateway's `/readyz` answers `503` until it loads, so an orchestrator routes no traffic to it | open | `embedding.ts`, `gateway.ts` |
| A request spends its embedding budget (`detection.embeddingMaxPassesPerRequest`) | The rest is read by the heuristic stage only; the request warns with stage `scan-budget` | open | `pipeline.ts` |
| The judge (Ollama) is unreachable or errors | It returns `ERROR` and the scan carries on without it | open | `judge.ts` |
| A tool result blocks (`detection.surfaces.tool_result.onBlock: withhold`, the default) | Its text is replaced with a fixed notice and the rest forwarded; refused if the text cannot be found in the body or it is the 17th in one request | closed for that text | `pipeline.ts`, `withhold.ts` |
| A user message other than the newest blocks (`detection.surfaces.prompt.olderTurns: withhold`, the default) | Its text is replaced with a fixed notice and the rest forwarded; refused if it cannot be removed, or removing it would change the newest message | closed for that text | `pipeline.ts`, `withhold.ts` |
| An image or audio clip llm-fw cannot read | Forwarded with a `non-text` warn; `nonText.mode: block` refuses it | open by default | `pipeline.ts` |
| A token-saving module throws | Logged; the request continues unmodified | open | `modules/registry.ts` |
| A response over `proxy.maxBodyBytes` | Forwarded verbatim from that point, inspection stops | open | `proxy.ts` |
| A compressed response llm-fw cannot decode | Forwarded verbatim, not inspected | open | `proxy.ts` |
| A compressed streaming (SSE) response | Forwarded verbatim, not inspected; the proxy asks upstream for `Accept-Encoding: identity`, so it takes an upstream that ignores that | open | `proxy.ts` |
| A WebSocket upgrade to anything but the OpenAI Realtime API or Gemini Live | `501` | closed | `proxy.ts`, `gateway.ts` |
| A Realtime or Gemini Live message, fragments included, over `proxy.maxBodyBytes` | Session closed with code `1009` and a `dos` event | closed | `realtimeRelay.ts` |
| A plain-HTTP request to the proxy | `501` | closed | `proxy.ts` |
| A `CONNECT` to a host that is not intercepted | Tunnelled without inspection, by design | open | `proxy.ts` |
| A `CONNECT` from a non-loopback client into the host's loopback or link-local addresses | `403` | closed | `tunnelGuard.ts` |
| Observe mode, deployment-wide or per tenant | Every refusal is recorded and the request forwarded | open, by configuration | `pipeline.ts` |

The open rows are deliberate trade-offs. Response-side inspection is defence in depth behind the request side. A judge that is down must not take the firewall down with it. A refusal for a spent embedding budget would turn a long session resumed after a restart into an outage while the heuristic stage still reads every byte.

