# Data Model: Tool Result Shunt

## Config: `modules.toolResultShunt`

Type `ToolResultShuntConfig extends ModuleSwitchConfig` in `src/types.ts`, default in
`DEFAULT_CONFIG.modules` (`src/config/config.ts`). Every key is warm (`HOT_PATHS` in
`src/config/hotReload.ts`). Environment: `LLM_FW_TOOL_RESULT_SHUNT_ENABLED` only (strictly `'true'`).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | FR-001 |
| `tools` | string[] | see below | eligible tools; a name matches the tool of that name or one ending in `__` plus that name, as `toolResultTruncate.skipTools` (FR-003) |
| `minLines` | number | `350` | size threshold, lines (FR-002) |
| `minChars` | number | `20000` | size threshold, characters (FR-002) |
| `maxInputChars` | number | `200000` | largest result sent to the worker (FR-002) |
| `waitMs` | number | `15000` | most time added to one request (FR-008) |
| `workerUrl` | string | `''` | worker base URL, loopback only (FR-011, D4) |
| `workerModel` | string | `''` | model name passed to the worker |
| `retentionHours` | number | `24` | FR-024 |
| `maxStoreMB` | number | `200` | store cap, MiB (FR-025) |

Default `tools`: Claude Code `Bash`, `PowerShell`, `BashOutput`, `Grep`, `Glob`, `LS`; Codex `shell`,
`exec_command`; Gemini CLI `run_shell_command`, `search_file_content`, `glob`, `list_directory`. No
file-reading tool: none of `DEFAULT_CONFIG.modules.toolResultTruncate.skipTools` is in it.

An empty `workerUrl` or `workerModel` means no worker is set up (FR-011).

## Size

`lines` = number of `\n`-separated lines, a final `\n` not starting a new one, `0` for empty text;
`chars` = `text.length`. A result is at or above the threshold when `lines >= minLines` or
`chars >= minChars`. The condensed result's stated size uses the same measures.

## Eligibility (FR-002, FR-003)

Only `tool_result` text slots from `collectTextSlots` (`src/modules/payload.ts`) are examined, so
non-text results are never touched. Checks run in this order; the first that fails gives the
reason the result is forwarded whole:

1. Tool name unknown: neither `slot.toolName` nor `RememberedCalls.get(slot.toolCallId)`
   (`src/modules/toolCalls.ts`) gives one: `tool-unknown`.
2. Name not in `tools`: `excluded-tool`.
3. Call arguments (`toolArgs`, `src/modules/toolCalls.ts`) carry any of `offset`, `limit`,
   `view_range`, `head`, `tail`, `start_line`, `end_line` (a ranged read), or their JSON contains a
   stored original's file name (`/[0-9a-f]{64}\.txt/`, so reading the way back is never condensed
   again): `excluded-tool`.
4. Below the size threshold: `below-threshold`.
5. `chars > maxInputChars`: `too-large`.
6. `isLoopbackAddr(ctx.remoteAddress)` (`src/auth.ts`) false: `remote-client`.
7. Its slot in the Screening record's `flagged` (which includes a slot detection did not scan), or,
   for a result not yet decided, `all` true or no record on the context: `flagged`.

An eligible result is then decided once (Remembered outcome): condensed, or whole with
`worker-failed` (no worker, worker not local, error, timeout, empty or malformed answer),
`rejected` (over the FR-005 cap or failing the citation rules), `store-failed` (write failed or the
folder could not be restricted) or `store-full`.

`WholeReason` is these ten, in this order: `below-threshold`, `excluded-tool`, `tool-unknown`,
`too-large`, `remote-client`, `flagged`, `worker-failed`, `rejected`, `store-failed`, `store-full`.
`too-large` is the one reason US4-4's list leaves out.

## Remembered outcome (FR-006)

`Map<key, { out: { text: string; path: string } | { whole: WholeReason }; carriedAt: number }>`,
key `sha256(toolName + '\0' + text)`, no entry cap. Only decided outcomes are stored (steps 7 and
after); steps 1 to 6 are recomputed on every request. Every request that carries a remembered
result sets its `carriedAt` to `Date.now()`, dry run included.

- **Kept while carried (D9).** On the first `prepare` at least an hour after the last prune, every
  outcome other than `flagged` whose `carriedAt` is older than `retentionHours` is dropped (the
  clock a stored original expires by). A dropped result is decided again as new. A `flagged`
  outcome is kept until restart.
- **Kept on disk (D9 C).** Every decided outcome is also written as an outcome file ("Stored
  original" below) once decided, outside dry run. A key in neither the map nor `inflight` is first
  looked up there, inside its `inflight` decision so concurrent requests read it once: a valid file becomes the remembered outcome (`carriedAt` now) with no worker
  call; a missing or invalid one means decide as new. A file that cannot be written leaves the
  outcome in memory only (warned once, Design 7).
- **Decided once, concurrent requests included (FR-006).** `inflight: Map<key, Promise<outcome>>`
  holds a decision under way (worker call, store write, remember), deleted when it settles. A
  request carrying a key in it awaits that promise instead of calling the worker and uses the
  settled outcome as a remembered one (write-back included, FR-024). The owner registered first,
  so its deadline `start + waitMs` falls within the joiner's (FR-008).
- **Flags.** A condensed outcome is replayed byte-identical on every request that carries the
  result, until a request puts its own slot in `flagged`: it then becomes `flagged`, its outcome
  file is rewritten as `flagged` and its stored original deleted, outside dry run (plan Design 8,
  D11). `all` and a missing record never change a remembered outcome: a result first condensed was
  judged clean, by the same key, in a scan that judged every item. Nothing replaces a `flagged`
  outcome, a settling in-flight decision included (FR-012).

## Screening record (FR-012, D1)

`Screening` in `src/modules/screening.ts`, one per request, filled by the proxy and the gateway
while they screen, read by the module through `ctx.screening`.

| Input | Noted by |
| --- | --- |
| scan-item text the item loop reaches, item-cache hits included | `noteItemScanned(text)` from `Pipeline.run` meta `onItemScanned` |
| scan-item text with a warn outcome, or handed to the async judge | `noteItemFlag(text)` from `Pipeline.run` meta `onItemFlag` |
| DLP findings and the body before redaction | `noteDlp(preDlpBody, findings)` |
| MCP tool-result audit | `noteMcpAudit(toolUseId)` |
| scan did not judge every item (fail-open pipeline error; `result.enforced === false`) | `incomplete()` |

`flaggedSlots(slots)` takes the request's slots as the module sees them (after DLP) and returns
`{ flagged, all }`. `all` is true when `incomplete()` was called, when the pre-DLP body's slot
count differs from `slots.length`, or when a DLP finding's `match` appears in no pre-DLP slot text
of any kind, raw or in its `JSON.stringify` form; it applies only to results not yet decided
(Remembered outcome). `flagged`, filled whatever `all` is, holds the indices of `tool_result` slots
where:

- a noted item-flag text contains the slot's text (a parser may join a result's text parts), or
- the slot's `toolCallId` was MCP-audited, or
- the slot counts match and the pre-DLP slot at the same index contains a DLP `match`, raw or
  `JSON.stringify`-escaped. When they differ this rule is skipped: a slot DLP redacted no longer
  has its remembered key, so the module decides it as new and `all` keeps it whole, or
- `all` is false and no noted scanned text contains the slot's text: detection did not scan it
  (FR-012). Today that is every OpenAI Responses `function_call_output`, which
  `src/detection/parsers.ts` never extracts; extending the parser changes verdicts and is a
  follow-up. Exact match against a set of the scanned texts first, containment only for the rest
  (SC-005). Skipped when `all` is true: an incomplete scan leaves items unscanned by design, and
  `all` already keeps new results whole (plan Design 8).

DLP `match` values stay in memory for the request and are never logged.

## Stored original (FR-021 to FR-025; outcome files: FR-006, D9)

- **Folder**: `join(getLlmFwDir(), 'tool-results')`, resolved per call (`src/config/paths.ts`).
  Nothing but stored originals, outcome files and their temp files is written there.
- **Path**: `<folder>/<sha256 hex of the UTF-8 text>.txt`, absolute; depends only on the content.
- **Content**: the result's text as the module received it (D3), UTF-8, nothing added.
- **Outcome file**: `<folder>/<key>.outcome`, `key` the remembered outcome's hex key. Content: JSON,
  `{"condensed": "<the condensed result exactly as forwarded>"}` or `{"whole": "<WholeReason>"}`,
  nothing else (FR-014). Written whenever an outcome is decided and replaced when it changes (D11),
  never in dry run. Read back only once access is confirmed; valid when it parses to exactly one of
  the two shapes, `whole` is one of the ten `WholeReason`s and `condensed` contains this result's
  stored original path; anything else counts as missing.
- **Write**: into `<name>.<random>.tmp` in the same folder (`wx`, mode `0o600`), then rename; on any
  error the temp file is removed and the result is `failed`. An existing stored original counts as
  stored; an outcome file is replaced by the rename.
- **Access (FR-023)**: POSIX folder `0o700`, files `0o600`, confirmed by `stat` (no group or other
  bits, owner is `process.getuid()`); Windows `restrictDirPermissions` (`src/proxy/certs.ts`) on
  the folder, confirmed by icacls exiting 0, files inherit (D5). Confirmed when the folder is
  created or first used in this process; unconfirmed means `unrestricted`: nothing written, no
  outcome file read.
- **Retention**: a file's mtime is the last request that carried it; `touch` sets it to now on
  every carry outside observe mode, the outcome file of every remembered outcome and the stored
  original of every condensed one. Expired: mtime older than `retentionHours`.
- **Cap**: running totals of files and bytes over both kinds, built by a folder scan on first use
  and rebuilt by every sweep. A write reserves its bytes (a replaced outcome file its growth) before
  writing and is `full` when the total would pass `maxStoreMB`; nothing unexpired is deleted to make
  room. Write-backs obey the cap.
- **Sweep**: deletes every file in the folder (temp files included) whose mtime is expired; runs at
  start and every hour from `src/cli/start.ts`, module on or off.
- **Purge**: deletes every file in the folder, from the dashboard (contracts section 5).
- **Flip (D11)**: the stored original of a condensed outcome that becomes `flagged` is deleted.
- **Write-back (FR-024)**: a carried remembered outcome whose outcome file is missing, or a
  condensed one whose stored original is missing, has the missing file written again at the same
  path before forwarding; if that fails the remembered outcome is forwarded anyway and one warning
  is logged, and a missing stored original is counted in `missing`.

## Counters (FR-017, US4-4)

Card KPIs (`ModuleStats.kpis`, `src/modules/types.ts`), counted per tool-result occurrence in a
request (a result carried by 10 requests counts 10 times, like the other modules' token totals),
except where noted. Live events are the base `PayloadModule` events: token counts, no text.

| Key | Label | Value |
| --- | --- | --- |
| `condensed` | Results condensed | occurrences forwarded condensed |
| `whole` | Forwarded whole | string, `"<reason> <n>"` for each non-zero `WholeReason` in the order above, joined by `" · "` |
| `originalTokens` | Original tokens | `estimateTokens` of the originals forwarded condensed |
| `condensedTokens` | Condensed tokens | `estimateTokens` of their condensed results |
| `workerIn` | Worker tokens read | sum of `usage.prompt_tokens`, per worker call |
| `workerOut` | Worker tokens written | sum of `usage.completion_tokens`, per worker call |
| `waitAvgMs` | Average wait added (ms) | over requests where the module awaited the worker or the disk |
| `waitMaxMs` | Longest wait added (ms) | same requests |
| `storedFiles` | Stored originals | from the store's totals, `.txt` files only |
| `storedBytes` | Stored size (bytes) | from the store's totals, outcome files included (what the cap counts) |
| `missing` | Stored originals missing | failed write-backs |

In observe mode the counts are what would have happened (FR-015); the events carry
`applied: false`.
