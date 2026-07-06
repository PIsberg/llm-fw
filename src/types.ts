export interface UrlFilterConfig {
  enabled: boolean;
  entropyThreshold: number;
  allowlistDomains: string[];
  blocklistDomains: string[];
}

export interface ProxyConfig {
  mode: 'proxy' | 'sinkhole';
  // FAIL-SAFE kill switch. When true the proxy becomes a transparent pass-through
  // tunnel: NO TLS interception, NO detection, NO blocking — every CONNECT is piped
  // straight to its upstream. Set via LLM_FW_BYPASS=true (or config) to instantly
  // restore connectivity if a detection change or misconfiguration would otherwise
  // block legitimate traffic and lock the operator out. Proxy mode only.
  bypass?: boolean;
  port: number;
  httpsPort: number;
  // Interface the proxy listens on. Defaults to '127.0.0.1' (local-only). Set to
  // '0.0.0.0' to accept connections from other hosts — what `start --standalone`
  // does so multiple clients can share one firewall server.
  bindHost: string;
  upstreamTimeoutMs: number;
  maxBodyBytes: number;
  dnsServers: string[];
  urlFilter: UrlFilterConfig;
  // Domain suffixes whose subdomains are always TLS-intercepted in proxy mode
  // — tenant/regional API hosts that can't be enumerated as concrete targets
  // (e.g. <resource>.openai.azure.com). Defaults to the provider registry's
  // list; set [] to disable, or extend it for private endpoints. Proxy mode
  // only — suffixes are never written to the hosts-file sinkhole. Also
  // settable via LLM_FW_INTERCEPT_DOMAINS (comma-separated, replaces).
  interceptDomains?: string[];
}

export interface DetectionConfig {
  heuristicBlockThreshold: number;
  embeddingBlockThreshold: number;
  embeddingWarnThreshold: number;
  // Contrastive margin: the embedding stage only treats a prompt as injection
  // when (nearest-injection-sim − nearest-benign-sim) ≥ this. e5 scores every
  // imperative request to the assistant high, so benign agentic commands ("commit
  // the changes", "run the test suite") sit right at the absolute block threshold;
  // the margin is what separates them from real injections, which are markedly
  // closer to the injection anchors than to the benign ones. Optional; absent ⇒
  // 0 (pure absolute-threshold behaviour). Also LLM_FW_EMBEDDING_MARGIN.
  embeddingMarginThreshold?: number;
  chunkTokenLimit: number;
  chunkSize: number;
  chunkOverlap: number;
  judgeEnabled: boolean;
  judgeModel: string;
  judgeBlock: boolean;
  // Trained ONNX prompt-injection classifier — a learned generalization layer
  // (protectai/deberta-v3-base-prompt-injection-v2). Opt-in: the weights are
  // ~700 MB, so it is disabled by default and downloaded on first use.
  classifier?: ClassifierConfig;
  // Base URL of the Ollama server hosting the judge model. Defaults to the
  // local daemon; point it at a LAN GPU box or container via config or
  // LLM_FW_OLLAMA_URL.
  ollamaUrl?: string;
  // Escalation policy for Stage 3. When false (default) the judge runs only on
  // prompts the cheap stages already flagged suspicious. When true, the cheap
  // stages route instead of veto: every prompt is judged unless confidently
  // benign — the only policy that generalizes to novel jailbreak phrasings.
  judgeUnlessBenign?: boolean;
  // Run injection detection on the developer-supplied system prompt / instruction
  // content too. OFF by default: a normal app's system prompt is trusted and is
  // full of the very instruction-management language ("do not reveal your system
  // prompt", "ignore instructions in tool output", "these instructions override…")
  // that injection heuristics flag, so scanning it false-positives on essentially
  // every real request. Enable only when untrusted data is concatenated into the
  // system prompt (e.g. RAG-into-system). Also LLM_FW_SCAN_SYSTEM_PROMPT.
  scanSystemPrompt?: boolean;
  // Suppress a classifier BLOCK when the prompt only QUOTES / translates /
  // documents / fictionalizes injection content instead of issuing it (see
  // intentMention.ts). Downgrades such a block to a warn. ON by default, but has
  // no effect unless the classifier stage is enabled. Also
  // LLM_FW_INTENT_MENTION_ENABLED. Scoped to the prompt/system surface — never
  // applied to untrusted tool_result/document data.
  intentMention?: boolean;
  // Operator-driven false-positive suppression (see suppressions.ts). When a
  // prompt/system candidate's normalized text matches an operator-approved
  // suppression (added via the dashboard's "mark false positive" feedback),
  // downgrade what would otherwise be a BLOCK to a warn. ON by default; an
  // empty suppression list (the default, fresh-install state) is a no-op, so
  // enabling this never changes behaviour until an operator actually marks a
  // false positive. Also LLM_FW_SUPPRESSIONS_ENABLED. Scoped to prompt/system
  // — never applied to untrusted tool_result/document data.
  suppressions?: boolean;
  // Per-surface sensitivity overrides (Task B3). The untrusted data surfaces
  // (tool_result / document) can be tuned tighter (or looser) than the global
  // default without touching the thresholds every other surface relies on —
  // e.g. an operator who sees repeated indirect-injection near-misses in tool
  // output can lower heuristicBlockThreshold there without affecting how the
  // user's own prompt is scored. Only these two knobs are overridable; the
  // embedding stage's absolute block/warn cosines stay global — they are e5
  // calibration constants (see embedding.ts) and must not be tuned per-surface.
  // Absent (the default) ⇒ no override ⇒ identical behaviour to today. The
  // tool_result heuristic threshold is also settable via
  // LLM_FW_TOOL_RESULT_HEURISTIC_THRESHOLD; everything else is file-config only.
  surfaces?: { [S in 'tool_result' | 'document']?: {
    heuristicBlockThreshold?: number;
    embeddingMarginThreshold?: number;
  } };
  // What happens to a request when Pipeline.run() itself THROWS (a bug in a
  // parser/normalizer/stage, not a detected injection) — Task C2. Before this
  // setting existed the behavior was IMPLICIT: the throw propagated out of
  // handleRequest to the outer per-connection try/catch in handleConnect /
  // startSinkhole, which logged the error and returned 502 `{ error: "proxy
  // error" }` WITHOUT forwarding the request upstream — i.e. the request was
  // silently denied. `'closed'` makes that same deny-on-error behavior
  // explicit (as the standard 403 block response, like every other stage) and
  // is therefore the DEFAULT — it matches today's observed behavior.
  // `'open'` instead forwards the request upstream unscanned and emits an
  // audit ('error' kind) event, trading availability for a small detection
  // gap during the failure. Also settable via LLM_FW_FAIL_MODE.
  failMode: 'open' | 'closed';
  // Task C3 — opt-in worker_threads isolation for the embedding + classifier
  // model forward passes. OFF by default: both stages run in-process exactly
  // as before. When true, a single persistent worker thread hosts both
  // models (lazy-spawned on first use); a worker crash respawns once, then
  // permanently falls back to in-process inference with a console.warn. The
  // forward pass itself is numerically IDENTICAL either way — same model,
  // same dtype, same single-text (never batched) calls — see embedding.ts's
  // q8 calibration note. Also LLM_FW_WORKER_INFERENCE.
  workerInference?: boolean;
}

export interface ClassifierConfig {
  enabled: boolean;
  /** INJECTION probability at/above which a prompt is blocked (0–1). */
  blockThreshold: number;
  // Gray-zone floor for judge escalation (Option B two-tier policy): a score in
  // [escalateThreshold, blockThreshold) is not confident enough to block outright
  // but too suspicious to pass — it is escalated to the Stage 3 judge for a
  // second opinion instead of silently passing. Below escalateThreshold the
  // classifier signal is treated as noise. Also LLM_FW_CLASSIFIER_ESCALATE.
  escalateThreshold?: number;
}

export interface DashboardConfig {
  port: number;
  maxEvents: number;
  // Interface the dashboard listens on. Defaults to '127.0.0.1' (local-only).
  // `start --standalone` sets it to '0.0.0.0' so the admin console and the CA
  // download endpoint are reachable from client machines.
  bindHost: string;
  // Shared secret required to access the dashboard from a NON-loopback address.
  // Loopback (the operator on the same machine) always bypasses auth. When the
  // dashboard is reachable remotely (bindHost not local) and no token is set, one
  // is auto-generated at startup and logged, so a standalone dashboard is never
  // left open. Override via LLM_FW_DASHBOARD_TOKEN.
  authToken?: string;
  // Task C4 — Prometheus text-exposition scrape endpoint at GET /metrics
  // (same auth gate as every other dashboard route). Default true; behind a
  // flag so an operator can opt out. Also LLM_FW_METRICS_ENABLED.
  metrics?: boolean;
}

export interface DLPConfig {
  enabled: boolean;
  mode: 'block' | 'redact' | 'audit';
  detectors: string[];
}

export interface DlpFinding {
  type: string;
  label: string;
  match: string;
  index: number;
}

export interface DosConfig {
  enabled: boolean;
  maxRequestsPerMinute: number;
  maxTokensPerSession: number;
  loopDetectionEnabled: boolean;
  // Rolling window (ms) after which the token budget auto-resets so the proxy
  // is not permanently locked out. 0 = lifetime budget (never resets).
  // Defaults to 1 hour when omitted.
  tokenBudgetWindowMs?: number;
}

interface RagConfig {
  enabled: boolean;
}

export interface ResponseScanConfig {
  // Scan the MODEL'S RESPONSE for data-exfiltration markup (markdown/HTML image
  // and link URLs pointing at exfil sinks). 'audit' emits an event and forwards
  // unchanged; 'block' additionally neutralizes the offending URL in buffered
  // (non-streaming) JSON responses. Default audit — rewriting model output is
  // intrusive, so blocking is opt-in.
  enabled: boolean;
  mode: 'block' | 'audit';
  // Also scan the response for harmful COMPLIANCE — concrete weapons/cyber/
  // illicit how-to content the model produced because a jailbreak slipped past
  // input detection. Audit-only defense-in-depth (always warns, never blocks):
  // output-content classification is fuzzier than input matching and a harmful
  // response can't be cleanly neutralized. Default on. Independent of `mode`.
  harmfulCompliance?: boolean;
  // Trained ONNX output-moderation classifier (Task B5, Option D) — a learned
  // generalization layer over the regex-based harmfulCompliance co-occurrence
  // scan, for responses whose harmful content doesn't match the hand-written
  // vocabulary/procedural patterns. Opt-in: disabled by default (small model,
  // but still a network download + inference cost per response). Unlike
  // harmfulCompliance (always audit-only), this stage RESPECTS `mode`: block
  // actually blocks the buffered (non-streaming) response; streamed SSE text
  // is already forwarded by the time it's scored, so it can only audit. See
  // src/detection/outputClassifier.ts for the model choice + rationale.
  classifier?: OutputClassifierConfig;
  // Outbound tool-call argument exfiltration guard (Task C1): scans the
  // serialized ARGUMENTS of every tool_use/tool_call/functionCall the model's
  // response carries with the existing DLP pattern engine + UrlClassifier —
  // closing the vector where a model hands a tool a secret/PII value or an
  // attacker-controlled exfil URL that the input-side scan never saw (it only
  // sees what the USER sent). On by default (audit) — reuses established,
  // low-false-positive detectors, no new heuristics. mode 'block' additionally
  // withholds a BUFFERED (non-streaming) response; a flushed SSE stream has
  // already reached the agent by scan time, so it always degrades to audit —
  // same rule as the response-harm classifier layer. Also
  // LLM_FW_TOOLUSE_SCAN_ENABLED / _MODE.
  toolUse?: { enabled: boolean; mode: 'audit' | 'block' };
}

export interface OutputClassifierConfig {
  enabled: boolean;
  /** HF model id. Defaults to the model chosen in outputClassifier.ts. */
  model?: string;
  /** Flagged-label probability at/above which a response is treated as harmful (0–1). */
  blockThreshold?: number;
}

export interface AsciiSmugglingConfig {
  // Detect & block invisible-character instruction smuggling (Unicode Tags
  // block, bidi overrides, plane-14 variation selectors). On by default — the
  // presence of these channels in prompt text is essentially never legitimate.
  enabled: boolean;
}

export interface NonTextConfig {
  // Handle non-text content blocks (images, PDFs, documents, audio) in
  // requests (issue #60). Text-bearing payloads (text/* documents, JSON,
  // data-URL files, PDFs with uncompressed text) are decoded and scanned by
  // the normal pipeline regardless of mode. For OPAQUE blocks (raster images,
  // audio) that cannot be inspected locally: 'audit' emits a warn event so
  // the unscanned content is visible on the dashboard; 'block' returns 403 —
  // opt-in for deployments that cannot tolerate uninspectable input.
  enabled: boolean;
  mode: 'audit' | 'block';
  // Opt-in OCR (issue #60). When true, opaque RASTER IMAGES are run through a
  // local WASM OCR engine (tesseract.js — no Python, no network at runtime once
  // the language data is cached) and any recovered text is scanned by the
  // normal pipeline. This catches injection text rendered as pixels (e.g. a
  // pasted screenshot) that would otherwise be uninspectable. Off by default:
  // it adds ~0.2–2s per image and a lazy ~12 MB model/lang download.
  ocr?: boolean;
}

// A non-text content block found in a request payload. `text` is present when
// the payload could be decoded into scannable text (then the pipeline treats
// it like any prompt); blocks without `text` are opaque to local inspection.
export interface MediaBlock {
  kind: 'image' | 'document' | 'audio' | 'video' | 'file';
  mimeType?: string;
  sizeBytes?: number;
  text?: string;
  // Raw base64 payload, retained ONLY for opaque raster images so the optional
  // OCR stage can read the pixels. Never serialized into events (callers that
  // emit blocks map fields explicitly). Absent for text-bearing / remote blocks.
  data?: string;
}

export interface TaintConfig {
  enabled: boolean;
  // 'audit' warns and forwards (visibility); 'block' returns 403 on a tainted
  // data flow. Default 'audit' — taint has inherent false positives, so blocking
  // is opt-in.
  mode: 'audit' | 'block';
}

export interface ManyShotConfig {
  // Detect many-shot jailbreaking — a single prompt stuffed with many
  // fabricated dialogue turns whose faux assistant answers demonstrate
  // compliance with escalating harmful asks, conditioning the model via
  // in-context learning. A long faux dialogue alone only warns (real
  // transcripts get pasted for summarization); a block additionally requires
  // multiple faux assistant turns exhibiting harmful compliance.
  enabled: boolean
  minTurns: number
  harmfulComplianceThreshold: number
  mode: 'audit' | 'block'
}

export interface CrescendoConfig {
  // Detect multi-turn crescendo jailbreaks — a conversation that escalates over
  // several turns toward harmful content, where the final user turn is a
  // boundary-pushing escalation directive. Analyzed within a single request
  // (LLM APIs resend the whole conversation), so no session state is needed.
  enabled: boolean
  minUserTurns: number
  mode: 'audit' | 'block'
  // Opt-in cross-request escalation memory (Task B4) — see
  // src/detection/crescendo.ts CrescendoSessionMemory. Default false: a
  // shared/multi-tenant proxy risks cross-client bleed if the session
  // identity collides, and it is unbounded-memory-growth risk if enabled
  // carelessly.
  crossRequest?: boolean
}

export interface IndirectInstructionConfig {
  // Detect indirect prompt injection — an imperative action-instruction planted
  // in tool/document data (the primary agentic attack vector; InjecAgent). Runs
  // only on the tool_result / document surfaces, where an imperative directing
  // the agent to a sensitive side-effecting action has no legitimate origin.
  enabled: boolean
  mode: 'audit' | 'block'
}

export interface HarmfulRequestConfig {
  // Detect requests for operationally harmful content (weapon/drug synthesis,
  // intrusion how-tos, fraud, hateful/defamatory material) — a content-
  // moderation layer the injection-specific stages miss. Tightly precision-
  // gated; disable for a pure injection firewall.
  enabled: boolean
  mode: 'audit' | 'block'
}

export interface McpConfig {
  enabled: boolean;
  blockedTools: string[];
  auditOnly: boolean;
  guardrailsEnabled: boolean;
  guardrailsCategories: {
    a: boolean;
    b: boolean;
    c: boolean;
    d: boolean;
  };
}

export interface Config {
  proxy: ProxyConfig;
  detection: DetectionConfig;
  dashboard: DashboardConfig;
  dlp: DLPConfig;
  dos: DosConfig;
  rag: RagConfig;
  mcp: McpConfig;
  taint?: TaintConfig;
  asciiSmuggling?: AsciiSmugglingConfig;
  responseScan?: ResponseScanConfig;
  nonText?: NonTextConfig;
  manyShot?: ManyShotConfig;
  crescendo?: CrescendoConfig;
  indirectInstruction?: IndirectInstructionConfig;
  harmfulRequest?: HarmfulRequestConfig;
  targets: string[];
  // Extra hostnames appended to `targets` after all config layers are merged.
  // File-config arrays REPLACE the defaults wholesale, so overriding `targets`
  // to add one self-hosted endpoint would drop the entire built-in provider
  // registry — this is the additive path. Also settable via
  // LLM_FW_EXTRA_TARGETS (comma-separated).
  extraTargets?: string[];
  // Task C5 — watch `<getLlmFwDir()>/config.json` for edits and hot-apply
  // detection/dlp/dos/rag/mcp/nonText/manyShot/crescendo/indirectInstruction/
  // harmfulRequest/responseScan toggles+thresholds without a restart (see
  // src/config/hotReload.ts for the exact hot-safe key list). Cold keys
  // (proxy ports/mode/bind/bypass, dashboard port/bind, targets/
  // interceptDomains/extraTargets) are detected but NOT applied — a
  // "restart required" note is logged instead. On by default. Also
  // LLM_FW_HOT_RELOAD.
  hotReload?: boolean;
}

export interface HeuristicResult {
  score: number;
  matches: string[];
}

export interface EmbeddingResult {
  similarity: number;
  nearest: string;
  chunkCount: number;
  // Nearest-BENIGN-anchor cosine for the most-injection-like chunk. The pipeline
  // blocks on the contrastive margin (similarity − benignSimilarity), not the raw
  // similarity: e5 scores every imperative command to the assistant high, so a
  // benign agentic prompt ("commit the changes") and an injection ("ignore your
  // instructions") overlap on absolute cosine but separate cleanly on which
  // intent they are closer to. Optional/defaulted so legacy callers and test
  // mocks (which only set `similarity`) behave as a zero-benign baseline.
  benignSimilarity?: number;
}

export interface JudgeResult {
  verdict: 'SAFE' | 'MALICIOUS' | 'ERROR';
  latencyMs: number;
}

export interface PipelineResult {
  action: 'block' | 'pass' | 'warn';
  stage: 'heuristic' | 'embedding' | 'classifier' | 'judge' | 'rag' | 'ascii-smuggling' | 'non-text' | 'many-shot' | 'crescendo' | 'indirect-instruction' | 'harmful-request' | 'none';
  score: number;
  similarity: number;
  verdict?: string;
  prompt?: string;
  heuristicMatches?: string[];
  nearestTemplate?: string;
  ragTag?: string;
  smuggleRanges?: string[];
}

export interface BlockEvent {
  id: string;
  timestamp: string;
  stage: string;
  score: number;
  similarity: number;
  target: string;
  method: string;
  path: string;
  payload_preview: string;
  payload_full: string;
  action: 'blocked' | 'warned' | 'passed';
  kind?: 'prompt' | 'url' | 'dlp' | 'dos' | 'rag' | 'mcp' | 'unparsed' | 'taint' | 'ascii-smuggling' | 'response-exfil' | 'response-harm' | 'non-text' | 'many-shot' | 'crescendo' | 'classifier' | 'tool-use-exfil' | 'error';
  // Mime-type summary of opaque non-text blocks ("image/png ×2, audio/wav").
  mediaSummary?: string;
  urlBlockReason?: string;
  // Exfil URL found in the model's response by the response-side scanner.
  exfilUrl?: string;
  // Invisible-character channels found by the ASCII-smuggling detector
  // (e.g. ['unicode-tags']), shown in the event detail.
  smuggleRanges?: string[];
  dlpType?: string;
  dosReason?: string;
  ragTag?: string;
  mcpTool?: string;
  mcpRule?: string;
  heuristicMatches?: string[];
  nearestTemplate?: string;
  verdict?: string;
  sandboxClient?: string;
  isSandboxed?: boolean;
  sandboxConfidence?: number;
}

// An event an operator marked as a false positive, persisted to
// ~/.llm-fw/whitelist.json so the decision survives restarts.
export interface WhitelistEntry {
  id: string;
  payload: string;
  stage: string;
  target: string;
  whitelistedAt: string;
  reason?: string;
}

/** One ordered turn of a conversation, for multi-turn (crescendo) analysis. */
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface PayloadParser {
  supports(path: string): boolean;
  extractPrompts(body: string): string[];
  // Developer-supplied system / instruction content (system prompt, OpenAI
  // `system`/`developer` messages + `instructions`, Cohere `preamble`, Gemini
  // `systemInstruction`, Bedrock Converse `system`). This is a TRUSTED surface —
  // it carries the app's own instruction-management language ("do not reveal your
  // system prompt", "ignore instructions in tool output") which is exactly what
  // injection heuristics flag, so the pipeline excludes it from injection
  // scanning by default. Optional; parsers without it fall back to the legacy
  // behaviour where `extractPrompts` already includes the system content.
  extractSystem?(body: string): string[];
  extractTools(body: string): unknown[];
  extractToolResults(body: string): { toolUseId: string; result: string }[];
  extractToolUses(body: string): { toolName: string; args: unknown }[];
  // Non-text content blocks (images, documents, audio). Optional — parsers
  // without media support simply leave non-text content unreported.
  extractMediaBlocks?(body: string): MediaBlock[];
  // Ordered conversation turns (user/assistant/system) for multi-turn
  // crescendo analysis. Optional — parsers without it skip crescendo detection.
  extractConversation?(body: string): ConversationTurn[];
}

export interface TrafficMetric {
  id: string;
  timestamp: string;
  service: string;
  host: string;
  bytesSent: number;
  bytesReceived: number;
  /** Client (source) IP address that opened the connection. */
  fromIp?: string;
  /** Whether the proxy TLS-inspected the request body (target hosts only). */
  inspected?: boolean;
  /** HTTP method — inspected requests only. */
  method?: string;
  /** Request path — inspected requests only. */
  path?: string;
  /** Sanitized request headers (auth/secret values redacted) — inspected requests only. */
  reqHeaders?: Record<string, string>;
  /** Decoded request body, truncated — inspected requests only. */
  requestBody?: string;
  /** True when requestBody was truncated to the size cap. */
  bodyTruncated?: boolean;
}
