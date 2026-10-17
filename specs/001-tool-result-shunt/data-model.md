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
7. Flagged by the Screening record, or no record on the context: `flagged`.

An eligible result is then decided once (Remembered outcome): condensed, or whole with
`worker-failed` (no worker, worker not local, error, timeout, empty or malformed answer),
`rejected` (over the FR-005 cap or failing the citation rules), `store-failed` (write failed or the
folder could not be restricted) or `store-full`.

`WholeReason` is these ten, in this order: `below-threshold`, `excluded-tool`, `tool-unknown`,
`too-large`, `remote-client`, `flagged`, `worker-failed`, `rejected`, `store-failed`, `store-full`.
`too-large` is the one reason US4-4's list leaves out.

## Remembered outcome (FR-006)

`Map<key, { text: string; path: string } | { whole: WholeReason }>`, key
`sha256(toolName + '\0' + text)`, least recently used evicted past 4,096 entries. Only decided
outcomes are stored (steps 7 and after); steps 1 to 6 are recomputed on every request. A
condensed outcome is replayed byte-identical on every request that carries the result. A
`flagged` outcome stays whole for good (FR-012).

## Screening record (FR-012, D1)

`Screening` in `src/modules/screening.ts`, one per request, filled by the proxy and the gateway
while they screen, read by the module through `ctx.screening`.

| Input | Noted by |
| --- | --- |
| scan-item text with a warn outcome, or handed to the async judge | `noteItemFlag(text)` from `Pipeline.run` meta `onItemFlag` |
| DLP findings and the body before redaction | `noteDlp(preDlpBody, findings)` |
| MCP tool-result audit | `noteMcpAudit(toolUseId)` |
| scan did not judge every item (fail-open pipeline error; `result.enforced === false`) | `incomplete()` |

`flaggedSlots(slots)` takes the request's slots as the module sees them (after DLP) and returns
`'all'` when `incomplete()` was called, when the pre-DLP body's slot count differs from
`slots.length`, or when a DLP finding's `match` appears in no pre-DLP slot text of any kind, raw or
in its `JSON.stringify` form. Otherwise it returns the indices of `tool_result` slots where:

- a noted item-flag text contains the slot's text (a parser may join a result's text parts), or
- the slot's `toolCallId` was MCP-audited, or
- the pre-DLP slot at the same index contains a DLP `match`, raw or `JSON.stringify`-escaped.

DLP `match` values stay in memory for the request and are never logged.

## Stored original (FR-021 to FR-025)

- **Folder**: `join(getLlmFwDir(), 'tool-results')`, resolved per call (`src/config/paths.ts`).
  Nothing else is written there.
- **Path**: `<folder>/<sha256 hex of the UTF-8 text>.txt`, absolute; depends only on the content.
- **Content**: the result's text as the module received it (D3), UTF-8, nothing added.
- **Write**: into `<name>.<random>.tmp` in the same folder (`wx`, mode `0o600`), then rename; on any
  error the temp file is removed and the result is `failed`. An existing file counts as stored.
- **Access (FR-023)**: POSIX folder `0o700`, files `0o600`, confirmed by `stat` (no group or other
  bits, owner is `process.getuid()`); Windows `restrictDirPermissions` (`src/proxy/certs.ts`) on
  the folder, confirmed by icacls exiting 0, files inherit (D5). Confirmed when the folder is
  created or first used in this process; unconfirmed means `unrestricted`, nothing written.
- **Retention**: a file's mtime is the last request that carried it; `touch` sets it to now on
  every carry outside observe mode. Expired: mtime older than `retentionHours`.
- **Cap**: running totals of files and bytes, built by a folder scan on first use and rebuilt by
  every sweep. A write reserves its bytes before writing and is `full` when the total would pass
  `maxStoreMB`; nothing unexpired is deleted to make room. Write-backs obey the cap.
- **Sweep**: deletes every file in the folder (temp files included) whose mtime is expired; runs at
  start and every hour from `src/cli/start.ts`, module on or off.
- **Purge**: deletes every file in the folder, from the dashboard (contracts section 5).
- **Write-back (FR-024)**: a remembered condensed result whose file is missing is written again at
  the same path before forwarding; if that fails the remembered text is forwarded anyway, one
  warning is logged and `missing` counts it.

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
| `storedFiles` | Stored originals | from the store's totals |
| `storedBytes` | Stored size (bytes) | from the store's totals |
| `missing` | Stored originals missing | failed write-backs |

In observe mode the counts are what would have happened (FR-015); the events carry
`applied: false`.
