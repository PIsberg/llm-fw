export interface ProxyConfig {
  mode: 'proxy' | 'sinkhole';
  port: number;
  httpsPort: number;
  upstreamTimeoutMs: number;
  dnsServers: string[];
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

export interface Config {
  proxy: ProxyConfig;
  detection: DetectionConfig;
  dashboard: DashboardConfig;
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
  stage: 'heuristic' | 'embedding' | 'judge' | 'none';
  score: number;
  similarity: number;
  verdict?: string;
  prompt?: string;
  heuristicMatches?: string[];
  nearestTemplate?: string;
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
  action: 'blocked' | 'warned';
}

export interface PayloadParser {
  supports(path: string): boolean;
  extractPrompts(body: string): string[];
}
