import { Config } from '../types.js';
import { cosmiconfig } from 'cosmiconfig';

export const DEFAULT_CONFIG: Config = {
  proxy: {
    mode: 'proxy',
    port: 8080,
    httpsPort: 443,
    upstreamTimeoutMs: 30000,
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
  targets: ['api.anthropic.com', 'generativelanguage.googleapis.com'],
};

export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
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

  let config = deepMerge<Config>(DEFAULT_CONFIG, found?.config ?? {});

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

  return config;
}
