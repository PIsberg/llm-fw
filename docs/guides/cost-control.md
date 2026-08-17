[llm-fw](../../README.md) > [Documentation](../README.md) > Cost Control & DoS Protection

# Cost Control & DoS Protection

Autonomous agents (AutoGPT, LangChain, CrewAI, …) can fall into recursive tool-calling loops or be pushed there by an indirect prompt injection — racking up API charges ("denial of wallet") or exhausting local compute. Because `llm-fw` sits between the agent and the upstream API, it acts as a **circuit breaker** with two cooperating components: a **Quota Manager** and a **Loop Detector**.

### Rate limiting & budgets (Quota Manager)

- **Requests Per Minute (RPM)**: a sliding 60-second window of request timestamps. When admitting a request would exceed `maxRequestsPerMinute`, the proxy returns `429 Too Many Requests` with a `Retry-After` header (seconds until the oldest in-window request expires) and body `{ "error": "rate limit exceeded", "retryAfter": <sec> }`. The check runs **before** the request body is buffered, so run-away agents are throttled cheaply.
- **Token budget**: every forwarded request contributes an estimated token count (`ceil(chars / 4)`) toward a running total — counting **both** the request payload **and** the streamed upstream response (large generations and runaway loops cost mostly on the response side). Once it exceeds `maxTokensPerSession`, subsequent requests are rejected with `429 { "error": "session token budget exceeded" }`. The budget is a **rolling window** that auto-resets every `tokenBudgetWindowMs` (default 1 hour) so a long-lived proxy is never permanently locked out; set `tokenBudgetWindowMs: 0` for a true lifetime budget that only clears on a manual dashboard reset.

### Loop detection (Loop Detector)

Agents stuck in a loop tend to resend an identical request body. The detector keeps a ring buffer of the last ~20 request-body SHA-256 hashes with timestamps. If the **same** body hash appears **more than 3 times (≥4) within a 10-second window**, the circuit trips and the proxy returns `429 { "error": "Agent Loop Detected" }`. Loop detection only runs on recognised LLM JSON requests (those with a registered parser).

When any breaker trips, a critical `dos` event is logged to the dashboard (shown under the **Rate Limit / DoS** badge with a `dos` stage chip). Well-behaved clients honour `Retry-After` and back off; aggressive loops are broken outright.

### Configuration

```json
{
  "dos": {
    "enabled": true,
    "maxRequestsPerMinute": 60,
    "maxTokensPerSession": 500000,
    "loopDetectionEnabled": true,
    "tokenBudgetWindowMs": 3600000
  }
}
```

Environment overrides:

| Variable | Effect |
|----------|--------|
| `LLM_FW_DOS_ENABLED` | `true`/`false` — enable or disable the DoS circuit breaker |
| `LLM_FW_DOS_MAX_RPM` | integer — requests allowed per rolling minute |
| `LLM_FW_DOS_MAX_TOKENS_PER_SESSION` | integer — token budget per rolling window |
| `LLM_FW_DOS_TOKEN_WINDOW_MS` | integer — token-budget window in ms before auto-reset (`0` = lifetime) |
