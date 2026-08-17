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

Only two knobs are exposed per surface, and only for `tool_result`/`document`:

- `heuristicBlockThreshold` — the Stage 1 score at which that surface blocks.
- `embeddingMarginThreshold` — the minimum contrastive margin required (the gap between the top injection-anchor cosine and the top benign-anchor cosine) for that surface's Stage 2 to act on an embedding match; overrides the global default (`0.02`) for this surface only.

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
