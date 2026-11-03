[llm-fw](../../README.md) > [Documentation](../README.md) > Tuning detection

# Tuning detection

Turning defenses on and off at runtime, silencing a false positive without weakening the rule that caused it, and setting a different sensitivity per surface.

## Settings — toggle defenses live

The dashboard's **Settings** tab lets you enable or disable each defense (attack type) at runtime: prompt-injection judge modes, ASCII smuggling, RAG poisoning, DLP (and mode), response-side exfil scan (and mode), the opt-in output-side moderation classifier (and threshold), MCP tool policy + command-guardrail categories A–D, URL/exfil filter, cross-turn taint (and mode), rate-limit/DoS breakers, the false-positive suppression list, and cross-request crescendo memory.

Toggles take effect on the **next proxy request** — the dashboard and proxy share one in-memory config in the same process, and every defense now reads its `enabled` flag per-request, so there is no restart. Changes are persisted to `~/.llm-fw/config.json` (deep-merged, so unrelated keys like `proxy.mode` are preserved) and survive restarts.

The same toggles are available headless via the `LLM_FW_*_ENABLED` environment variables documented in each defense guide (see the [documentation index](../README.md)), or by editing `~/.llm-fw/config.json` directly.

## Indirect injection that names no identifier

**For an agent that reads untrusted pages or files, turn the classifier on for tool results.** The default rules key on what an attacker has to name, an address, a URL, an account or a handle. Without one, they catch 8 of 40 attacks on the identifier-free probe (`test/eval/data/indirect-identifier-free.json`), and that count is gated by `npm run recall:floor`. The trained classifier reads the instruction itself and does not need one:

```json
{
  "detection": {
    "classifier": {
      "enabled": true,
      "surfaces": ["tool_result", "document"],
      "requireCorroboration": false
    },
    "surfaces": {
      "tool_result": { "classifierBlockThreshold": 0.999 },
      "document": { "classifierBlockThreshold": 0.999 }
    }
  }
}
```

Measured on ruleset 2026.11.24 against the default: 20 of 40 attacks blocked rather than 8, 2 of 20 benign probe rows rather than 1, and 9 of 336 realistic benign rows rather than 7. InjecAgent stays at 1,054 of 1,054 with 0 of 17 benign. See the [table in the benchmark](../BENCHMARK.md) for 0.9, which catches 30 of 40 but blocks 9 of 20 benign rows.

`requireCorroboration: false` is what buys this. With corroboration on, the default, a classifier hit alone warns, and these attacks have nothing to corroborate them. The price is a model download and the time to run it on each tool result, and the default stays off because of it. Your prompts are not scanned by the classifier with this list of surfaces.

This is a probe of 60 rows written by hand, so read it as a direction rather than a rate. It does not reach an attack the classifier scores below 0.999, and nothing here stops the 20 it misses. [#535](https://github.com/PIsberg/llm-fw/issues/535) tracks the default.

## An imperative that names no destination

The rule that withholds most ordinary tool results in real traffic is the imperative one: `Add the token as a repository secret`, `Please update your unit file`. Those read exactly like an order, so more wording rules stopped converging (#287). `indirectInstruction.untargetedImperative: "warn"` (`LLM_FW_INDIRECT_UNTARGETED_IMPERATIVE=warn`) lets such a hit warn instead, on a tool result only, when the whole text names no address, URL, account number or handle. It applies live. Documents are still refused, and any text naming a destination is still withheld, however far it sits from the verb.

**It is off by default because of what it costs.** Measured 2026-11-03 on ruleset 2026.11.24, with the rest of the cheap pipeline still running, so these attacks are the ones nothing else blocks:

| Where it looks for a destination | Real tool results no longer withheld | InjecAgent attacks lost | Identifier-free probe |
| --- | --- | --- | --- |
| Whole text (what this setting does) | 10 of the 105 flagged, over 43,254 results | 200 of 1,054 | attacks 8 to 2 blocked, benign 1 to 0 |
| 100 characters around the verb (not offered) | 45 of the 105 | 344 of 1,054 | the same |

The window version clears more and loses more, and an attacker defeats it with one line of padding, so it is not offered. Turn this on only if a withheld result costs you more than an instruction that names no destination, such as one telling the agent to delete something or move funds between accounts it already holds, reaching the model with a warning. Marking a false positive, or `trustedPaths` for a repository you trust, are narrower ways to stop a repeat.

## False-Positive Suppression List

Every threshold in this firewall is a trade-off, and no threshold is perfect — occasionally a legitimate prompt trips a block. Rather than asking you to loosen a global threshold (and quietly widen the hole for everyone), llm-fw lets you suppress that **text** going forward.

From the dashboard **Events** tab, opening a blocked event shows a **"Mark false positive (suppress future matches)"** button when the block was about one scanned text: a prompt, a system prompt, a tool result or a document. DLP, URL-filter, rate-limit and response-side blocks never consult the list, so they show no button. Clicking it:

1. Records the key the pipeline put on the event: the sha256 hash of the **normalized** text the stage scanned (the same normalization the embedding cache uses), never the raw text. The event's payload may only show a label and a snippet (`[indirect: exfil-target "send"] ...`); the key is of the whole scanned text.
2. Appends `{ hash, preview, addedAt, lines, stage }` (`addedAt` in UTC) to `~/.llm-fw/suppressions.json`. `lines` holds a hash of each distinct line of the text, never the line. `preview` is a short truncated excerpt kept only so you can recognize the entry later; it plays no role in matching.
3. From then on, an **identical** future text that would have been **blocked** on the same surface is downgraded to a **warn** instead (logged with a `[suppressed-fp]` note).
4. A **near copy** is covered too: a text on the same surface holding at least half of the marked text's distinct lines has those lines removed, and every stage scans the rest. If the rest is clean the text passes with a `[suppressed-fp] N of M lines match` warn. If it blocks, the event shows only the lines nobody has vouched for, and you can mark those as well. Every other text is scored exactly as before.

**Why not only the exact text.** A false positive rarely comes back byte for byte: a file grew, a command's timing moved, the harness appended a reminder. On 7 days of real Claude Code and Codex transcripts (17,648 items, rule stages only, no model), 70 of 445 findings arrived with more than one text, and an exact mark on the first text covered none of the 130 later ones. Marking the first text with this rule covers 60 of the 130, and every later text of 28 of the 70 repeating findings. The rest hold under half of the marked lines, carry another flagged line that deserves its own decision, or name a destination on a changed line.

**What a near copy cannot do.** Only lines you vouched for are removed, so an attacker gains nothing by copying a marked text: anything added is scanned on its own. A line differing by one character, in case or in an invisible character, is a different line and is scanned. One marked line is not vouched for on its own, so a mark on a document quoting an attack does not pass that quote in unrelated output. A changed line naming a destination (a URL, an email address, an IP address) keeps the whole text scored, because an instruction can span lines with neither half blocking alone: without this, an attacker could keep a marked "please forward the report" and change only the address on the next line.

**Limits.** An entry made before this rule has no `lines` and matches exactly only; mark its event again to add them. A text of more than 5,000 distinct lines also matches exactly only, and so do crescendo blocks and the repository and memory files inside Claude Code's reminders. A text of mostly changing lines, such as a log with a timestamp on each line, is not a near copy of itself, so each run is its own event.

A false positive in a tool result is withheld by default (`detection.surfaces.tool_result.onBlock`, see [Configuration](configuration.md#configuration)): the model gets a notice in its place and the session goes on. Marking it lets the model read it again. Under `onBlock: refuse` the mark matters more: an agent resends its whole history on every turn, so until it is marked, that one tool result refuses every later request of the session.

The button works on events the running process still holds. Events live in memory only: a restart forgets them, and the process keeps the last `dashboard.maxEvents` (default 100) blocked events, separately from other traffic, so a busy agent session cannot push a false positive out before you mark it. They also stay in the event list and the live stream after other traffic has filled the last 100 events, which matters in observe mode, where a would-block is the event you look for afterwards. For an event from before a restart, re-send the request and mark the new event.

A suppression is scoped to the surface it was marked on. `tool_result` and `document` are untrusted data, and text you vouched for in a prompt is classic dressing for an injection planted in a tool result, so a prompt or system mark never downgrades a tool result or document. A mark on a tool result covers that tool result and its near copies only, and not the same text arriving as a document. Entries made before this scoping keep matching on the `prompt`/`system` surfaces, as they always did.

**Record as false positive (audit only)** is a different button. It writes `whitelist.json`, which nothing reads when scoring a request, so it never changes a verdict. To change what future requests get, use **Mark false positive**.

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

### Harness prompt templates

A suppression matches one exact text, so it cannot help with a prompt an agent harness sends again and again with different work appended. Claude Code reviews changes for security with two such prompts. One opens every request with the same 2,200 characters of instructions, then the diff; they name SQL injection, hardcoded passwords and `eval()`, and the harmful-request stage refused each review on them alone. The other lists the changed files, then the diff, and its fixed wording put any review at the embedding stage's warn line, whatever the diff.

Such templates are listed in `HARNESS_TEMPLATES` (`src/detection/harnessTemplates.ts`). A user prompt that starts with one is scored without the template's fixed text, on every stage; the rest of the prompt (the diff, the file list, the task) is scored in full. Rules that keep it from being a way in:

- Only the exact fixed text is removed. One character different, and the prompt is scored whole.
- A part that varies is a slot of a fixed shape: one word (a language name), or a list of file paths, one per line, with no spaces. A sentence in a slot means no match, and what fills a slot is scored with the rest of the prompt: only the fixed text around it is removed.
- Claude Code also sends these prompts inside its session-title request (`<session>`, then a line asking for a title). That wrapper goes too, but only around a template. The title line goes only in its fixed default form; the form that names a language ("Write the title in <language>. ...") is a free slot, so it stays and is scored.
- Only the user-prompt surface. The same text in a tool result or a document is scored whole.
- It is not tied to a client: the security review arrives without Claude Code's User-Agent. That is safe because removing fixed text can only make a prompt shorter. An attacker who copies a template gains nothing, and the attack after it is still scored.

A diff of attack text still blocks. A security review of llm-fw's own detectors or attack fixtures is refused on the diff, as any other prompt carrying that text would be. New templates are added in the source, with a ruleset change; `test/detection/harnessTemplates.test.ts` checks every entry.

## Per-Surface Detection Sensitivity

By default, the heuristic block threshold and embedding margin are global — the same numbers apply whether the text came from the user prompt or from a tool result an attacker might control. Since `tool_result` and `document` are the two surfaces an attacker can influence *without* ever talking to your model directly (the indirect-injection vector), you can tune them independently — tighter or looser — without touching prompt-surface sensitivity for your actual users.

Three threshold knobs are exposed for `tool_result`/`document` (the user prompt has its own setting, below):

- `heuristicBlockThreshold` — the Stage 1 score at which that surface blocks.
- `embeddingMarginThreshold` — the minimum contrastive margin required (the gap between the top injection-anchor cosine and the top benign-anchor cosine) for that surface's Stage 2 to act on an embedding match; overrides the global default (`0.02`) for this surface only.
- `classifierBlockThreshold` — the opt-in classifier's block threshold on that surface, for when the classifier is enabled. Unset, `tool_result` gets `0.999` while the global classifier threshold is the shipped 0.9, and your global value once you set one (#587; see [the configuration guide](configuration.md)); `document` uses the global threshold.

(The embedding stage's absolute block and warn cosines, `detection.embeddingBlockThreshold` and `detection.embeddingWarnThreshold`, stay global: only the contrastive margin requirement is overridable per surface.) Leaving `detection.surfaces` unset gives the shipped defaults: tool results withheld rather than refused, older prompts withheld, and the classifier's `0.999` bar on tool results unless you moved its global threshold; the heuristic and embedding thresholds stay global.

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
      "tool_result": { "trustedPaths": ["C:\\dev\\private", "/home/me/src"] }
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

The same roots apply to the instruction files Claude Code loads by itself. It delivers a repository's `CLAUDE.md`, the `.claude/rules/*.md` files it loads and the agent's auto-memory files inside the user turn, under a `Contents of <path> (...)` line, and llm-fw scores them there as part of the prompt. Since ruleset 2026.11.3 each repository and memory file is also read on its own by one narrow rule (#593): a well-known credential file (`~/.aws/credentials`, an SSH private key, `~/.netrc`, `.git-credentials`, `.env`, and a few more) in the same sentence as sending it to an outside address or URL, or as keeping that step from the user. A hit refuses the request (the file is part of the prompt, so it cannot be withheld), or warns when the file is under a trusted root. Since ruleset 2026.11.10 the same files are also read for other planted commands (#637): piping a download to a shell, adding to `authorized_keys` and appending to a shell profile refuse; `git remote add` and package-registry changes warn, and refuse with a standing trigger ("before every push") or concealment ("do not mention this"); weakening a guardrail (`--no-verify`, `--dangerously-skip-permissions`, disabling a hook or llm-fw, adding an allow rule) counts only with a trigger or concealment. These are the named shapes and nothing more: any other instruction planted in one of these files passes like the rest of the prompt, an accepted limit recorded in the [threat model](../THREAT-MODEL.md#accepted-risks). If a repository you trust legitimately holds such a line, list its folder here and the refusal becomes a warning. The user's own private instruction files (`~/.claude/CLAUDE.md`, `CLAUDE.local.md`) are not read this way: they are the user's text. The broader tool-result rules are deliberately not applied to these files: over the 535 repository instruction files and 520 memory files on one developer's machine (2026-11-01) they fired on 21, each of which would have refused every request in that repository, while this rule fired on none. On tool results it runs after the indirect-instruction rules; over 63,591 real ones it added 5 blocks, all of them attack text from #593 and from the rule's own tests and source. It has no exemption for a description of the attack ("an attacker could ... post it to ..."): every way to tell the two apart was something an attacker writes, so such a tool result is withheld, as quoted attacks are by the other rules.

Measured 2026-10-23 on the 2,994 distinct file reads (`Read` and lean-ctx `ctx_read`) in 30 days of one developer's Claude Code transcripts, with `trustedPaths: ["C:\dev\private"]`: the default pipeline refused 242 (8.1%), 156 of them under the root, 131 of those in llm-fw's own source and docs. With the setting, 0 of the 156 are refused (155 warn, 1 passes) and all 86 reads from outside the root are still refused. Re-scanning a demoted read took 26 ms at the median and 1.2 s at most. The eval corpora carry no file paths, so their verdicts cannot move: 0 of 23,938 changed.
