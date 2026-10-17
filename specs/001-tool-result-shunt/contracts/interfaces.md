# Interfaces: Tool Result Shunt

## 1. Condensed result (to the agent; FR-004, FR-005, FR-013)

The module replaces the result's text with exactly this, `{facts}` being the worker's answer
trimmed of leading and trailing whitespace:

```text
[llm-fw: tool output condensed from {lines} lines and {chars} characters.
The complete, exact original is in this file; read it, or any line range of it, with your file-reading tool:
{path}
Line numbers below are line numbers of that file.]
{facts}
```

- `{lines}` and `{chars}` are the original's size (data-model.md "Size"), digits only.
- `{path}` is the stored original's absolute path (data-model.md "Stored original").
- No expiry, no other tool, handle or file is named by the module.
- FR-005 cap: `estimateTokens(whole condensed result) <= 0.5 * estimateTokens(original)`
  (`src/modules/tokens.ts`), else `rejected`.

## 2. Citation rules (FR-009, FR-013)

Applied to `{facts}` only; the module's own lines are exempt. Any failure means `rejected`.

- **Paths**: every token with a `/` or `\` separator (`(?:[A-Za-z]:)?[\w.@~-]*(?:[\\/][\w.@~-]+)+`),
  and every `name.ext` directly followed by `:<digits>`, together with a trailing `:<line>` or
  `:<line>:<col>`, must occur verbatim in the original.
- **Line references**: every `line N`, `lines N-M` (hyphen or en-dash, case-insensitive) and
  `LN` / `LN-LM` must have every number in `1..lines`, unless the exact reference text occurs
  verbatim in the original (a quoted compiler message).
- Empty `{facts}` is `worker-failed`, not `rejected`.

## 3. Worker request (FR-010, FR-011, D4)

```http
POST {workerUrl}/v1/chat/completions
Content-Type: application/json

{"model": "{workerModel}", "temperature": 0, "stream": false, "max_tokens": {cap},
 "messages": [{"role": "system", "content": WORKER_INSTRUCTIONS},
              {"role": "user", "content": numberLines(original)}]}
```

- `workerUrl` must parse as `http:` or `https:` with hostname `localhost`, an IPv4 literal in
  `127.0.0.0/8` or the IPv6 literal `::1`; any other DNS name is not local, even one that starts
  with `127.` or `localhost.` (`127.0.0.1.nip.io`, `localhost.attacker.example`). Checked before
  every send. Otherwise nothing is sent and the result is `worker-failed`.
- No other header: no `Authorization`, no client or provider header.
- `redirect: 'error'`, aborted at the request's deadline.
- `numberLines` prefixes each line with its 1-based number and a tab, so cited line numbers are
  line numbers of the stored file.
- `{cap}` = `floor(0.5 * estimateTokens(original)) - estimateTokens(header)`, the most the FR-005
  cap could accept.
- Answer used: `choices[0].message.content` when a string; `usage.prompt_tokens` and
  `usage.completion_tokens`, `0` when absent. Any other status, shape or a thrown error:
  `worker-failed`. The text is untrusted: it is only measured, checked and inserted.
- Partial read (D12): `usage.prompt_tokens` absent, or below
  `0.8 * (estimateTokens(WORKER_INSTRUCTIONS) + estimateTokens(numberLines(original)))`, means the
  worker read only part of the input: `worker-failed`, problem `partial-input`, before the answer
  is checked.

## 4. `WORKER_INSTRUCTIONS`

A fixed string in `src/modules/shuntWorker.ts`. It tells the worker that the input is one tool
output with numbered lines, and to write only facts from it: failures and errors verbatim
(failing test names, error messages), warnings, the final status or exit code, summary counts,
the paths involved, and line numbers or ranges where the detail is; counts as words or as the input
writes them, not as new fractions (a `/` it adds is checked as a path, section 2); no advice, no
instructions, no commentary, no text that is not in the input.

## 5. Dashboard

`POST /api/modules/tool-result-shunt/purge`, same guard as `POST /api/modules`
(`checkSameOrigin` in `src/dashboard/server.ts`: `Content-Type: application/json`, same origin;
415 or 403 otherwise). Body ignored. Deletes every file in the folder, stored originals and
outcome files (FR-025, D9), and answers `200 {"ok": true, "deleted": <count of files>}`; `404 {"error": "unknown module"}` when the module is not
registered. The module's card in `renderModuleCards` carries a "Delete stored originals" button
that posts to it and then reloads the cards.
