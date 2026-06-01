import { Config } from '../types.js';
import { cosmiconfig } from 'cosmiconfig';

export const DEFAULT_CONFIG: Config = {
  proxy: {
    mode: 'proxy',
    port: 8080,
    httpsPort: 8443,
    upstreamTimeoutMs: 30000,
    maxBodyBytes: 10_485_760, // 10 MiB — cap buffered request body to bound memory
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    urlFilter: {
      enabled: true,
      entropyThreshold: 4.8,
      allowlistDomains: [
        'api.anthropic.com',
        'generativelanguage.googleapis.com',
        'github.com',
        'npmjs.org',
        'registry.npmjs.org',
        'googleapis.com',
      ],
      blocklistDomains: [],
    },
  },
  detection: {
    heuristicBlockThreshold: 50,
    embeddingBlockThreshold: 0.85,
    embeddingWarnThreshold: 0.70,
    chunkTokenLimit: 300,
    chunkSize: 200,
    chunkOverlap: 50,
    judgeEnabled: false,
    judgeModel: 'phi3',
    judgeBlock: false,
  },
  dashboard: {
    port: 7731,
    maxEvents: 100,
  },
  dlp: {
    enabled: true,
    mode: 'redact',
    detectors: ['aws', 'github', 'slack', 'stripe', 'private_keys', 'mongodb', 'entropy', 'pii'],
  },
  dos: {
    enabled: true,
    maxRequestsPerMinute: 60,
    maxTokensPerSession: 500000,
    loopDetectionEnabled: true,
    tokenBudgetWindowMs: 3_600_000, // auto-reset the token budget hourly
  },
  rag: {
    enabled: true,
  },
  targets: ['api.anthropic.com', 'googleapis.com'],
};

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as object, srcVal as object) as T[keyof T];
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

export async function loadConfig(): Promise<Config> {
  const explorer = cosmiconfig('llm-fw', {
    searchPlaces: [
      'package.json',
      '.llm-fw.json',
      '.llm-fwrc',
      '.llm-fwrc.json',
      '.llm-fwrc.yaml',
      '.llm-fwrc.yml',
      '.llm-fwrc.js',
      'llm-fw.config.js'
    ]
  });
  const found = await explorer.search();

  // ~/.llm-fw/config.json persists settings written by setup (e.g. sinkhole mode).
  // It takes priority over project-level config but is overridden by env vars below.
  let userConfig: Partial<Config> = {};
  try {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const p = join(homedir(), '.llm-fw', 'config.json');
    userConfig = JSON.parse(readFileSync(p, 'utf8')) as Partial<Config>;
  } catch { /* not present */ }

  let config = deepMerge<Config>(
    deepMerge<Config>(DEFAULT_CONFIG, found?.config ?? {}),
    userConfig
  );

  const env = process.env;

  if (env['LLM_FW_PROXY_PORT']) {
    config.proxy.port = parseInt(env['LLM_FW_PROXY_PORT'], 10);
  }
  if (env['LLM_FW_PROXY_MODE']) {
    config.proxy.mode = env['LLM_FW_PROXY_MODE'] as 'proxy' | 'sinkhole';
  }
  if (env['LLM_FW_HTTPS_PORT']) {
    config.proxy.httpsPort = parseInt(env['LLM_FW_HTTPS_PORT'], 10);
  }
  if (env['LLM_FW_MAX_BODY_BYTES']) {
    config.proxy.maxBodyBytes = parseInt(env['LLM_FW_MAX_BODY_BYTES'], 10);
  }
  if (env['LLM_FW_JUDGE_ENABLED']) {
    config.detection.judgeEnabled = env['LLM_FW_JUDGE_ENABLED'] === 'true';
  }
  if (env['LLM_FW_JUDGE_BLOCK']) {
    config.detection.judgeBlock = env['LLM_FW_JUDGE_BLOCK'] === 'true';
  }
  if (env['LLM_FW_JUDGE_MODEL']) {
    config.detection.judgeModel = env['LLM_FW_JUDGE_MODEL'];
  }
  if (env['LLM_FW_EMBEDDING_BLOCK_THRESHOLD']) {
    config.detection.embeddingBlockThreshold = parseFloat(env['LLM_FW_EMBEDDING_BLOCK_THRESHOLD']);
  }
  if (env['LLM_FW_EMBEDDING_WARN_THRESHOLD']) {
    config.detection.embeddingWarnThreshold = parseFloat(env['LLM_FW_EMBEDDING_WARN_THRESHOLD']);
  }
  if (env['LLM_FW_DASHBOARD_PORT']) {
    config.dashboard.port = parseInt(env['LLM_FW_DASHBOARD_PORT'], 10);
  }
  if (env['LLM_FW_DLP_ENABLED']) {
    config.dlp.enabled = env['LLM_FW_DLP_ENABLED'] === 'true';
  }
  if (env['LLM_FW_DLP_MODE']) {
    config.dlp.mode = env['LLM_FW_DLP_MODE'] as 'block' | 'redact' | 'audit';
  }
  if (env['LLM_FW_DOS_ENABLED']) {
    config.dos.enabled = env['LLM_FW_DOS_ENABLED'] === 'true';
  }
  if (env['LLM_FW_DOS_MAX_RPM']) {
    config.dos.maxRequestsPerMinute = parseInt(env['LLM_FW_DOS_MAX_RPM'], 10);
  }
  if (env['LLM_FW_DOS_MAX_TOKENS_PER_SESSION']) {
    config.dos.maxTokensPerSession = parseInt(env['LLM_FW_DOS_MAX_TOKENS_PER_SESSION'], 10);
  }
  if (env['LLM_FW_DOS_TOKEN_WINDOW_MS']) {
    config.dos.tokenBudgetWindowMs = parseInt(env['LLM_FW_DOS_TOKEN_WINDOW_MS'], 10);
  }
  if (env['LLM_FW_RAG_ENABLED']) {
    config.rag.enabled = env['LLM_FW_RAG_ENABLED'] === 'true';
  }

  return config;
}
