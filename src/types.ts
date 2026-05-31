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
}

export interface RagConfig {
  enabled: boolean;
}

export interface Config {
  proxy: ProxyConfig;
  detection: DetectionConfig;
  dashboard: DashboardConfig;
  dlp: DLPConfig;
  dos: DosConfig;
  rag: RagConfig;
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
  action: 'blocked' | 'warned';
  kind?: 'prompt' | 'url' | 'dlp' | 'dos' | 'rag';
  urlBlockReason?: string;
  dlpType?: string;
  dosReason?: string;
  ragTag?: string;
  heuristicMatches?: string[];
  nearestTemplate?: string;
  verdict?: string;
}

export interface PayloadParser {
  supports(path: string): boolean;
  extractPrompts(body: string): string[];
}
