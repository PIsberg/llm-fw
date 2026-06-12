export interface UrlFilterConfig {
  enabled: boolean;
  entropyThreshold: number;
  allowlistDomains: string[];
  blocklistDomains: string[];
}

export interface ProxyConfig {
  mode: 'proxy' | 'sinkhole';
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
  chunkTokenLimit: number;
  chunkSize: number;
  chunkOverlap: number;
  judgeEnabled: boolean;
  judgeModel: string;
  judgeBlock: boolean;
  // Base URL of the Ollama server hosting the judge model. Defaults to the
  // local daemon; point it at a LAN GPU box or container via config or
  // LLM_FW_OLLAMA_URL.
  ollamaUrl?: string;
  // Escalation policy for Stage 3. When false (default) the judge runs only on
  // prompts the cheap stages already flagged suspicious. When true, the cheap
  // stages route instead of veto: every prompt is judged unless confidently
  // benign — the only policy that generalizes to novel jailbreak phrasings.
  judgeUnlessBenign?: boolean;
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
  targets: string[];
  // Extra hostnames appended to `targets` after all config layers are merged.
  // File-config arrays REPLACE the defaults wholesale, so overriding `targets`
  // to add one self-hosted endpoint would drop the entire built-in provider
  // registry — this is the additive path. Also settable via
  // LLM_FW_EXTRA_TARGETS (comma-separated).
  extraTargets?: string[];
}

export interface HeuristicResult {
  score: number;
  matches: string[];
}

export interface EmbeddingResult {
  similarity: number;
  nearest: string;
  chunkCount: number;
}

export interface JudgeResult {
  verdict: 'SAFE' | 'MALICIOUS' | 'ERROR';
  latencyMs: number;
}

export interface PipelineResult {
  action: 'block' | 'pass' | 'warn';
  stage: 'heuristic' | 'embedding' | 'judge' | 'rag' | 'ascii-smuggling' | 'non-text' | 'many-shot' | 'none';
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
  kind?: 'prompt' | 'url' | 'dlp' | 'dos' | 'rag' | 'mcp' | 'unparsed' | 'taint' | 'ascii-smuggling' | 'response-exfil' | 'non-text' | 'many-shot';
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

export interface PayloadParser {
  supports(path: string): boolean;
  extractPrompts(body: string): string[];
  extractTools(body: string): unknown[];
  extractToolResults(body: string): { toolUseId: string; result: string }[];
  extractToolUses(body: string): { toolName: string; args: unknown }[];
  // Non-text content blocks (images, documents, audio). Optional — parsers
  // without media support simply leave non-text content unreported.
  extractMediaBlocks?(body: string): MediaBlock[];
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
