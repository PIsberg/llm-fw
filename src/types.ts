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

export interface TaintConfig {
  enabled: boolean;
  // 'audit' warns and forwards (visibility); 'block' returns 403 on a tainted
  // data flow. Default 'audit' — taint has inherent false positives, so blocking
  // is opt-in.
  mode: 'audit' | 'block';
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
  targets: string[];
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
  stage: 'heuristic' | 'embedding' | 'judge' | 'rag' | 'ascii-smuggling' | 'none';
  score: number;
  similarity: number;
  verdict?: string;
  prompt?: string;
  heuristicMatches?: string[];
  nearestTemplate?: string;
  ragTag?: string;
  smuggleRanges?: string[];
}

export interface SandboxResult {
  client: string;
  sandboxed: boolean;
  confidence: number;
  signals: string[];
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
  kind?: 'prompt' | 'url' | 'dlp' | 'dos' | 'rag' | 'mcp' | 'unparsed' | 'taint' | 'ascii-smuggling' | 'response-exfil';
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
