[llm-fw](../../README.md) > [Documentation](../README.md) > Tuning detection

# Tuning detection

Turning defenses on and off at runtime, silencing a false positive without weakening the rule that caused it, and setting a different sensitivity per surface.

## Settings — toggle defenses live

The dashboard's **Settings** tab lets you enable or disable each defense (attack type) at runtime: prompt-injection judge modes, ASCII smuggling, RAG poisoning, DLP (and mode), response-side exfil scan (and mode), the opt-in output-side moderation classifier (and threshold), MCP tool policy + command-guardrail categories A–D, URL/exfil filter, cross-turn taint (and mode), rate-limit/DoS breakers, the false-positive suppression list, and cross-request crescendo memory.

Toggles take effect on the **next proxy request** — the dashboard and proxy share one in-memory config in the same process, and every defense now reads its `enabled` flag per-request, so there is no restart. Changes are persisted to `~/.llm-fw/config.json` (deep-merged, so unrelated keys like `proxy.mode` are preserved) and survive restarts.

The same toggles are available headless via the `LLM_FW_*_ENABLED` environment variables documented in each defense guide (see the [documentation index](../README.md)), or by editing `~/.llm-fw/config.json` directly.

## False-Positive Suppression List

Every threshold in this firewall is a trade-off, and no threshold is perfect — occasionally a legitimate prompt trips a block. Rather than asking you to loosen a global threshold (and quietly widen the hole for everyone), llm-fw lets you suppress that **exact** prompt going forward.

From the dashboard **Events** tab, opening a blocked event on the `prompt`/`system` surface shows a **"Mark false positive (suppress future matches)"** button. Clicking it:

1. Computes the sha256 hash of the **normalized** prompt text (the same normalization the embedding cache uses) — never the raw prompt itself is stored.
2. Appends `{ hash, preview, addedAt }` (`addedAt` in UTC) to `~/.llm-fw/suppressions.json` (`preview` is a short truncated excerpt kept only so you can recognize the entry later; it plays no role in matching).
3. From then on, an **identical** future prompt that would have been **blocked** on the `prompt`/`system` surface is downgraded to a **warn** instead (logged with a `[suppressed-fp]` note) — every other prompt is scored exactly as before.

The button works on events the running process still holds. Events live in memory only: a restart forgets them, and the process keeps the last `dashboard.maxEvents` (default 100) blocked events, separately from other traffic, so a busy agent session cannot push a false positive out before you mark it. For an event from before a restart, re-send the request and mark the new event.

Suppressions are intentionally scoped to the trusted `prompt`/`system` surfaces — `tool_result` and `document` are untrusted data, so a match there is never downgraded, no matter what's in the list.

`GET /api/suppressions` lists current entries; `DELETE /api/suppressions` removes one — both behind the existing dashboard auth-token middleware.

### Configuration

```json
{
  "detection": {
    "suppressions": true
  }
}
```

Environment overrides:

| Variable | Effect |
|----------|--------|
| `LLM_FW_SUPPRESSIONS_ENABLED` | `true`/`false` — enable or disable the suppression list (default `true`) |

## Per-Surface Detection Sensitivity

By default, the heuristic block threshold and embedding margin are global — the same numbers apply whether the text came from the user prompt or from a tool result an attacker might control. Since `tool_result` and `document` are the two surfaces an attacker can influence *without* ever talking to your model directly (the indirect-injection vector), you can tune them independently — tighter or looser — without touching prompt-surface sensitivity for your actual users.

Three threshold knobs are exposed for `tool_result`/`document` (the user prompt has its own setting, below):

- `heuristicBlockThreshold` — the Stage 1 score at which that surface blocks.
- `embeddingMarginThreshold` — the minimum contrastive margin required (the gap between the top injection-anchor cosine and the top benign-anchor cosine) for that surface's Stage 2 to act on an embedding match; overrides the global default (`0.02`) for this surface only.
- `classifierBlockThreshold` — the opt-in classifier's block threshold on that surface, for when the classifier is enabled.

(The embedding stage's absolute block/warn cosines stay global e5-calibration constants — only the contrastive margin requirement is overridable per surface.) Leaving `detection.surfaces` unset is **bit-identical** to prior behavior.

### Configuration

```json
{
  "detection": {
    "surfaces": {
      "tool_result": {
        "heuristicBlockThreshold": 35,
        "embeddingMarginThreshold": 0.03
      },
      "document": {
        "heuristicBlockThreshold": 40
      }
    }
  }
}
```

Environment overrides:

| Variable | Effect |
|----------|--------|
| `LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD` | integer — overrides `detection.surfaces.tool_result.heuristicBlockThreshold` only; the rest of the per-surface config is file-only |
| `LLM_FW_PROMPT_WORDING_ACTION` | `block` or `warn` — sets `detection.surfaces.prompt.wordingAction`; any other value is ignored |
| `LLM_FW_TRUSTED_PATHS` | comma-separated project roots — sets `detection.surfaces.tool_result.trustedPaths` |

### Warn instead of block on the user's own prompt

Prompt injection does its damage when untrusted content (a web page, an email, a tool result) steers an agent. On the user-prompt surface the user is the principal, and that surface is where nearly all of the remaining false positives come from. `detection.surfaces.prompt.wordingAction: "warn"` turns a heuristic (Stage 1) or embedding (Stage 2) match on the user's prompt into a warn event, and the request is forwarded, unless the match clears a high-confidence tier:

- `highConfidenceHeuristic` — heuristic score at or above which the prompt still blocks. Default `60`; most single rules score `50`, so this asks for more than one.
- `highConfidenceSimilarity` and `highConfidenceMargin` — an embedding match at or above both still blocks. Defaults `0.88` and `0.05`; the normal block point is `0.86` and `0.02`.

Unaffected: `tool_result`, `document`, recalled memory and a scanned system prompt keep blocking (file reads from a trusted root are a separate setting, [below](#trust-file-reads-from-your-own-projects)), and so do the stages on the prompt that are not wording matches (harmful-request, RAG data blocks, ASCII smuggling, many-shot, crescendo, the classifier and the judge). A request let through this way still shows in Live Traffic as a warn.

```json
{
  "detection": {
    "surfaces": {
      "prompt": { "wordingAction": "warn" }
    }
  }
}
```

It is off by default because the trade is steep. Measured on 2026-10-10 over every eval split plus the full Dolly-15k (23,938 rows), with the default tier:

| | `block` (default) | `warn` |
| --- | --- | --- |
| Direct injection blocked (gandalf, safeguard, deepset, heldout) | 635 / 853 | 340 / 853 |
| Benign rows blocked | 12 / 20,971 | 2 / 20,971 |
| `benign-realistic` blocked | 9 / 336 | 1 / 336 |

The heuristic score counts rules rather than measuring confidence: "Ignore all previous instructions" matches one rule and scores 50, so gandalf's textbook overrides fall from 97 to 50 blocked. Turn it on when a user jailbreaking their own assistant is not a threat you need the firewall to stop, for example an internal tool whose model provider already enforces its own policy, and when agent traffic (tool results, documents) is the exposure you care about. See [False positives: deciding by surface](../FALSE-POSITIVES.md#deciding-by-surface-instead-of-by-wording) for the full sweep.

### Trust file reads from your own projects

An agent working in a security project, a game about rogue AIs, or llm-fw itself reads files that are full of injection-shaped text, and each read is a `tool_result`, the surface llm-fw guards hardest. `detection.surfaces.tool_result.trustedPaths` lists project roots whose files you vouch for:

```json
{
  "detection": {
    "surfaces": {
      "tool_result": { "trustedPaths": ["C:\dev\private", "/home/me/src"] }
    }
  }
}
```

A tool result is trusted only when all of these hold:

- the call that produced it is a local file read, matched by its full name: Claude Code's `Read`, `read_file`, `read_text_file`, lean-ctx's `mcp__lean-ctx__ctx_read`, or the MCP filesystem server's `mcp__filesystem__read_file` and `mcp__filesystem__read_text_file`; or it is a shell tool (Claude Code's `Bash`, Codex CLI's `shell`, `shell_command` and `exec_command`, the Responses API's built-in `local_shell_call`) whose command is exactly one plain read of one file: `cat`, `head`, `tail`, `sed -n` with a line range, `Get-Content`, `gc` or `type`, with only their line-selecting options, and nothing a shell could expand or chain (no pipe, redirection, `;`, `&&`, `$`, backtick, parentheses, glob or comma list). `Get-Content tests\t.py -TotalCount 50` counts; `Get-Content a.py | Select-Object -Last 120`, `git show`, `rg` and `curl` do not. Either way the call is paired with its result by id in Anthropic, OpenAI chat, Responses API, Bedrock Converse and Cohere requests. Gemini pairs by id when both sides carry one, and otherwise only when the preceding model turn called that tool once: with two same-named calls and no ids, neither result is trusted. A `read_file` on any other MCP server is not trusted, since it may be serving fetched content;
- every path argument the call carries (`file_path`, `absolute_path`, `path`, `filePath`, or the one path in the shell command) is absolute, or relative to a `workdir` the call itself names, as Codex's shell tools do, and, after `..` is resolved, lies under a listed root (Windows paths match case-insensitively, with either separator, but a Git Bash path such as `/c/dev/x` never matches a `C:\dev` root: Claude Code reads it as `C:\dev\x`, Node's own file API on Windows as `C:\c\dev\x`, so what it names depends on the client);
- no directory between the root and the file is `node_modules`, `bower_components`, `vendor`, `third_party`, `site-packages`, `.venv`, `venv` or `.git`, compared case-insensitively and ignoring trailing dots and spaces, as Windows does.

On a trusted read, the wording stages (heuristic, embedding, indirect-instruction, memory-poisoning and the RAG structural signal) warn instead of block, with no high-confidence tier, and the warn event names the file (`[trusted-path] <path>:`). ASCII smuggling, many-shot, the classifier and the judge still block. Shell output other than a plain read (`git diff`, `rg`, a script), fetched pages and search results are never trusted, whatever path they mention, and neither is a relative path without a `workdir` in the call (Claude Code's `Bash` sends none), since the proxy cannot see the working directory it is relative to. The embedding stage is skipped on a trusted read unless the judge is on, because there it can only warn: running it took 117 s on the first read of the 30 KB `docs/guides/detection-stages.md`, against 1.7 s without it.

The cost is the obvious one: an injection planted in a file under a trusted root, by a cloned repository or a merged pull request, only warns. List the directories you write yourself, not a folder you clone other people's code into. The check is lexical, so a symlink under a root that points elsewhere is trusted as if it were under the root. Windows spellings that name a different directory than they read as fail closed rather than being resolved, since a gateway may not see the client's disk: 8.3 short names (`NODE_M~1`), alternate data streams (`::$INDEX_ALLOCATION`), and `\\?\`, `\\.\` and UNC prefixes, in a path or in a configured root. The two MCP servers above are trusted by the name you registered them under, so a different server registered as `lean-ctx` or `filesystem` is taken at its word about which file it read.

Measured 2026-10-23 on the 2,994 distinct file reads (`Read` and lean-ctx `ctx_read`) in 30 days of one developer's Claude Code transcripts, with `trustedPaths: ["C:\dev\private"]`: the default pipeline refused 242 (8.1%), 156 of them under the root, 131 of those in llm-fw's own source and docs. With the setting, 0 of the 156 are refused (155 warn, 1 passes) and all 86 reads from outside the root are still refused. Re-scanning a demoted read took 26 ms at the median and 1.2 s at most. The eval corpora carry no file paths, so their verdicts cannot move: 0 of 23,938 changed.
