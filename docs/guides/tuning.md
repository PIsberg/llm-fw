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
2. Appends `{ hash, preview, addedAt }` to `~/.llm-fw/suppressions.json` (`preview` is a short truncated excerpt kept only so you can recognize the entry later; it plays no role in matching).
3. From then on, an **identical** future prompt that would have been **blocked** on the `prompt`/`system` surface is downgraded to a **warn** instead (logged with a `[suppressed-fp]` note) — every other prompt is scored exactly as before.

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

### Warn instead of block on the user's own prompt

Prompt injection does its damage when untrusted content (a web page, an email, a tool result) steers an agent. On the user-prompt surface the user is the principal, and that surface is where nearly all of the remaining false positives come from. `detection.surfaces.prompt.wordingAction: "warn"` turns a heuristic (Stage 1) or embedding (Stage 2) match on the user's prompt into a warn event, and the request is forwarded, unless the match clears a high-confidence tier:

- `highConfidenceHeuristic` — heuristic score at or above which the prompt still blocks. Default `60`; most single rules score `50`, so this asks for more than one.
- `highConfidenceSimilarity` and `highConfidenceMargin` — an embedding match at or above both still blocks. Defaults `0.88` and `0.05`; the normal block point is `0.86` and `0.02`.

Unaffected: `tool_result`, `document`, recalled memory and a scanned system prompt keep blocking, and so do the stages on the prompt that are not wording matches (harmful-request, RAG data blocks, ASCII smuggling, many-shot, crescendo, the classifier and the judge). A request let through this way still shows in Live Traffic as a warn.

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
