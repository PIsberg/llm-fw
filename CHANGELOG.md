# Changelog

All notable changes to **llm-fw** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

**Detection — new attack-class coverage**
- Many-shot jailbreak detector — flags a prompt stuffed with fabricated dialogue turns whose faux assistant answers demonstrate harmful compliance; blocks on the structural pattern + harmful compliance, warns on a benign pasted transcript (`manyShot.{enabled,minTurns,harmfulComplianceThreshold,mode}`, `LLM_FW_MANYSHOT_*`).
- Multi-turn crescendo detector — catches a conversation that escalates over several turns toward harmful content and ends on a boundary-pushing directive; analyzed within the request (LLM APIs resend the whole conversation), so no session state is needed (`crescendo.{enabled,minUserTurns,mode}`, `LLM_FW_CRESCENDO_*`).
- Heuristic rules for refusal-suppression, refusal-override, prefix-injection ("start your reply with 'Sure, here is'"), Skeleton Key (safe-context behavior-update), and Policy Puppetry (fake permission config).
- Base32 (RFC 4648) and Ascii85 (Adobe `<~ ~>`) obfuscation decoders added to the candidate extractor.
- Response-side harmful-compliance scan — audit-only defense-in-depth that flags a response containing a harmful how-to (a jailbreak the input stages missed and the model complied with); excludes refusals and high-level explanations (`responseScan.harmfulCompliance`, `LLM_FW_RESPONSE_HARM_ENABLED`).
- AWS Bedrock provider + Converse/InvokeModel parser; HuggingFace updated to the current `router.huggingface.co` endpoint; Cohere tool result/use extraction implemented.
- Proxy now intercepts Azure OpenAI and regional Vertex tenant hosts (`proxy.interceptDomains`, `LLM_FW_INTERCEPT_DOMAINS`).
- `extraTargets` config to append hosts without redeclaring the provider registry (`LLM_FW_EXTRA_TARGETS`); configurable Ollama base URL (`detection.ollamaUrl`, `LLM_FW_OLLAMA_URL`).

**Generalization layer & benchmarking**
- Trained ONNX prompt-injection classifier stage (`protectai/deberta-v3-base-prompt-injection-v2`, Apache-2.0) — a learned generalization layer that runs locally (no Ollama) and roughly doubles cheap-stage recall on an independent held-out benchmark with near-zero added false positives. Opt-in (~700 MB, lazy-loaded). Config `detection.classifier.{enabled,blockThreshold}`, `LLM_FW_CLASSIFIER_{ENABLED,THRESHOLD}`, and a Settings-tab toggle + threshold.
- Independent benchmark harness (`scripts/run-benchmark.ts`) + two held-out datasets (deepset public test split; self-authored novel phrasings) and a documented honest scorecard (`docs/BENCHMARK.md`). Finding: the generative Ollama judge blocks 27-86% of benign traffic when used as a general backstop, so `judgeUnlessBenign` is now documented as not recommended; the trained classifier is the precise alternative.

**Dashboard**
- Settings tab now exposes the new detectors (many-shot, crescendo, response-harm), the trained classifier (toggle + threshold), and an **Advanced — Tuning** group with validated number/text inputs for the heuristic/embedding/classifier thresholds, DoS rate/token limits, and judge model; every row carries an inline explanation. All settings apply live (JudgeClient and QuotaManager read their values from the live config) and persist to `~/.llm-fw/config.json`.

Scorecard: 110 attacks across 16 classes at 100% TPR / 0% FPR (heuristic + embedding, judge off).

### Changed
- `setup`/`setup-judge` write to `~/.llm-fw/config.json` via read-merge (no longer clobbering); judge settings persist machine-wide instead of cwd-relative.
- `setup` no longer disables IDE TLS verification (`http.proxyStrictSSL`); the CA in the OS trust store suffices.
- `LLM_FW_DIR` is now honoured by every consumer (CA, pid, config, whitelist, model cache) via a shared resolver.
- `setup` accepts `--judge`/`--no-judge` and skips the Stage 3 prompt on a non-interactive stdin.

### Fixed
- Dropped `google.com`/`googleusercontent.com` from the outbound URL-filter allowlist (now labelled as infrastructure, not trusted as exfil-safe).

## [0.1.0] - 2026-06-09

Initial release.

### Added

**Interception & transport**
- HTTP `HTTPS_PROXY` mode (no admin) and OS-level sinkhole mode (hosts file + `:443` redirect).
- Local TLS termination with a per-host SAN cert factory backed by a local root CA (key stored `0700` in `~/.llm-fw`); streaming request inspection with early `403` abort and zero-copy forwarding for safe traffic.
- Built-in provider registry covering OpenAI/Azure, Anthropic, Gemini/Vertex, Mistral, Groq, OpenRouter, Together, Fireworks, DeepSeek, xAI, Perplexity, Cohere, Anyscale, and HuggingFace; native parsing of any OpenAI-compatible endpoint.
- Standalone server mode (`--standalone`) to share one firewall across machines, with CA download endpoints.

**Detection pipeline**
- Stage 1 heuristic scoring with evasion normalization (Unicode NFKC, homoglyph/leetspeak folding, base64/hex/binary/morse/caesar/rot13/pig-latin/reversed decoders, entropy gating).
- Stage 2 embedding cosine similarity against a known-attack corpus using a local ONNX model with sliding-window chunking.
- Stage 3 optional local Ollama judge (async-monitor by default; sync-block and judge-unless-benign policies).
- Indirect-injection coverage: tool results, tool definitions (poisoning), and RAG context-poisoning (structural + judge signals).
- ASCII smuggling detection — invisible Unicode Tags, bidi overrides, and plane-14 variation selectors are decoded and blocked.

**Other defenses**
- Data Loss Prevention (cloud keys, tokens, private keys, cards, PII) with block/redact/audit modes.
- DoS / cost-control circuit breakers: per-minute rate limit, rolling token budget, identical-request loop detection.
- MCP tool firewall: allow/deny policy plus execution-context command guardrails (categories A–D) over request and streamed/buffered responses.
- Outbound URL/exfiltration filter (known sinks, DGA/high-entropy hosts, data-carrying query strings).
- Cross-turn taint tracking (audit/block) of untrusted tokens reused in outbound destinations.
- Response-side exfil detection — markdown/HTML image & link URLs in model responses, audited or neutralized; works on gzip/brotli/deflate-compressed responses.

**Dashboard** (`localhost:7731`)
- Events feed with expandable detail drawer and false-positive whitelisting.
- Prompt Testing playground across every detector, with a Google-Translate control for multilingual probing.
- Live Traffic throughput chart, per-service utilization, and connection log.
- Settings tab to enable/disable each defense live (no restart), persisted to `~/.llm-fw/config.json`.
- Token authentication required for non-loopback access (auto-generated when bound remotely); CSRF guard on state-changing endpoints.

**Tooling & quality**
- CLI: `setup`, `setup-judge`, `start`, `stop`, `status`, `doctor`, `uninstall`; IDE proxy auto-configuration and reversible env-var persistence.
- Test suite: unit, integration, Playwright e2e, and load (performance + accuracy) tests; a deterministic detection-accuracy regression gate (precision/recall with per-category floors) run in CI.
- Distribution: npm publish workflow (publishes with provenance on a GitHub Release).

[Unreleased]: https://github.com/PIsberg/llm-fw/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PIsberg/llm-fw/releases/tag/v0.1.0
