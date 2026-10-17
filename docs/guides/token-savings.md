[llm-fw](../../README.md) > [Documentation](../README.md) > Token savings

# Token savings

The firewall already sits on every LLM request, so it can also make requests
cheaper before they leave. Each technique below is a separate gateway module
with its own switch, its own KPIs on the dashboard's **Modules** tab, and its
own live events. All of them are off by default, because each one changes what
the provider receives.

## Turning a module on and off

Every module has a `modules.<key>.enabled` config key. Each can be flipped live,
without a restart, in any of these ways:

- the toggle on its card in the dashboard's **Modules** tab, which also
  persists the change to `~/.llm-fw/config.json`,
- `POST /api/modules` with `{"id": "<module id>", "enabled": true}`,
- editing `config.json`, which is hot-reloaded,
- the `LLM_FW_*_ENABLED` environment variable, at start-up.

`modules.enabled: false` (or `LLM_FW_MODULES_ENABLED=false`) turns off the
whole pipeline.

## What every module guarantees

- **It runs before DLP and detection**, on the proxy and on the gateway, so
  both scan the body that is actually forwarded. Text a module removes never
  reaches the model, so it cannot carry an injection either.
- **It fails open.** A module that throws is logged and skipped, and the
  request continues with the body as the previous module left it.
- **Observe mode is a dry run.** The module runs and its card counts what it
  would have saved, but the original body is forwarded.
- **The same history comes out byte-identical on every turn.** A rewrite
  depends only on the text it rewrites and on what comes before it in the
  request, never on time or on how long the conversation is. Two things depend
  on that: the provider's prompt cache, which matches on the exact prefix,
  and, on models with preserved thinking (Claude Fable 5.1, Opus 5.5, Sonnet
  5.5, Haiku 5.5), the signature on every thinking block, which records the
  conversation before it.

### Changing a module in the middle of a conversation

Turning a rewriting module on or off, or changing one of its options, changes
how the earlier turns of a running conversation are sent. The next request
misses the prompt cache once. On models with preserved thinking, accounts the
provider enforces the check for (Anthropic accounts created on or after
2026-08-31) get a 400 for that conversation: "The block is bound to a different
conversation." Start a new conversation after changing a module, or change
modules between sessions.

## Modules

| Module id | Config key | Rewrites |
| --- | --- | --- |
| `token-pruner` | `modules.tokenPruner` | prompt and system text |

### Token pruner

`modules.tokenPruner.enabled` (`LLM_FW_TOKEN_PRUNER_ENABLED`). Collapses
interior runs of spaces and tabs to one space, runs of blank lines to one, and
trailing whitespace, and minifies multiline JSON embedded in the text. Leading
indentation and fenced code are kept.

It rewrites user, assistant and system text in OpenAI chat, the OpenAI
Responses API (`input`, `instructions`), Anthropic (`messages`, `system`) and
Gemini (`contents`, `systemInstruction`). It never touches tool output: an
agent quotes a file read verbatim in its next edit, so a collapsed run of
spaces there makes the edit miss. It never touches thinking blocks either.

An unfenced string literal with aligned spaces is altered, which is why it is
opt-in.
