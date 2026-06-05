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
}

export interface DashboardConfig {
  port: number;
  maxEvents: number;
  // Interface the dashboard listens on. Defaults to '127.0.0.1' (local-only).
  // `start --standalone` sets it to '0.0.0.0' so the admin console and the CA
  // download endpoint are reachable from client machines.
  bindHost: string;
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
  stage: 'heuristic' | 'embedding' | 'judge' | 'rag' | 'none';
  score: number;
  similarity: number;
  verdict?: string;
  prompt?: string;
  heuristicMatches?: string[];
  nearestTemplate?: string;
  ragTag?: string;
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
  kind?: 'prompt' | 'url' | 'dlp' | 'dos' | 'rag' | 'mcp';
  urlBlockReason?: string;
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
