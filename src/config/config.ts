import { Config } from '../types.js';
import { cosmiconfig } from 'cosmiconfig';
import { AI_PROVIDER_HOSTS, AI_PROVIDER_DOMAINS } from './providers.js';

export const DEFAULT_CONFIG: Config = {
  proxy: {
    mode: 'proxy',
    port: 8080,
    httpsPort: 8443,
    // Local-only by default. `start --standalone` overrides this to 0.0.0.0 so
    // other machines on the network can use this host as their LLM proxy.
    bindHost: '127.0.0.1',
    // Idle timeout on the upstream socket. Generous by default: non-streaming
    // completions hold the connection silent until the whole body is generated,
    // so a short window aborts legitimate long generations. Lower it if you want
    // a tighter DoS backstop and only expect streaming traffic.
    upstreamTimeoutMs: 120000,
    maxBodyBytes: 10_485_760, // 10 MiB — cap buffered request body to bound memory
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    urlFilter: {
      enabled: true,
      entropyThreshold: 4.8,
      // Every known AI provider domain is trusted by default, plus the common
      // dev-tooling hosts. Derived from the provider registry so adding a
      // provider there automatically allowlists it here too.
      allowlistDomains: [
        ...AI_PROVIDER_DOMAINS,
        'github.com',
        'npmjs.org',
        'registry.npmjs.org',
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
    // qwen2.5 is strongly multilingual (Japanese, Korean, Arabic, Russian, CJK,
    // …) where phi3 is largely English-trained — the judge is the only detection
    // stage that generalizes across languages, so its model must too. The :3b tag
    // keeps local latency/footprint close to phi3-mini. Override via
    // LLM_FW_JUDGE_MODEL. Pair with judgeUnlessBenign so foreign-language prompts
    // that score zero on the (regex/embedding) cheap stages still reach the judge.
    judgeModel: 'qwen2.5:3b',
    judgeBlock: false,
    judgeUnlessBenign: false,
  },
  dashboard: {
    port: 7731,
    maxEvents: 100,
    bindHost: '127.0.0.1',
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
  taint: {
    enabled: true,
    mode: 'audit',
  },
  // Invisible-character instruction smuggling (Unicode Tags, bidi overrides,
  // plane-14 variation selectors). On by default — these channels are
  // essentially never legitimate in prompt text.
  asciiSmuggling: {
    enabled: true,
  },
  // Scan the model's RESPONSE for data-exfiltration markup (markdown/HTML image
  // & link URLs to exfil sinks). Audit by default — rewriting model output is
  // intrusive, so blocking is opt-in.
  responseScan: {
    enabled: true,
    mode: 'audit',
  },
  // Non-text content blocks (issue #60). Text-bearing payloads (text/* docs,
  // JSON, data-URL files, PDFs with uncompressed text) are decoded and scanned
  // like prompts. Opaque media (raster images, audio) can't be inspected
  // locally: audit (default) surfaces a warn event so it's no longer
  // invisible; block refuses requests carrying uninspectable content.
  nonText: {
    enabled: true,
    mode: 'audit',
  },
  mcp: {
    enabled: true,
    // Tools blocked outright by name. Note: a name on this list is rejected by
    // the blocklist check BEFORE the command-content guardrails run, so for an
    // execution tool like `execute_command` the per-command Category A–D scan
    // never executes under the default config — it's already name-blocked. The
    // guardrails therefore protect the execution tools NOT on this list
    // (`bash`, `ctx_shell`, `powershell`). Drop a tool from this list if you
    // want its arguments scanned rather than the whole tool refused.
    blockedTools: ['execute_command', 'delete_database'],
    auditOnly: false,
    guardrailsEnabled: true,
    guardrailsCategories: {
      a: true,
      b: true,
      c: true,
      d: true,
    },
  },
  // Every major AI provider's API host — the proxy TLS-inspects these and the
  // sinkhole redirects them. Sourced from the provider registry (providers.ts)
  // so the firewall covers all supported services out of the box.
  targets: AI_PROVIDER_HOSTS,
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

  // ~/.llm-fw/config.json persists settings written by setup (e.g. sinkhole mode).
  // It takes priority over project-level config but is overridden by env vars below.
  let userConfig: Partial<Config> = {};
  try {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { homedir } = await import('node:os');
    const p = path.join(homedir(), '.llm-fw', 'config.json');
    userConfig = JSON.parse(readFileSync(p, 'utf8')) as Partial<Config>;
  } catch { /* not present */ }

  let config = deepMerge<Config>(
    deepMerge<Config>(DEFAULT_CONFIG, (found?.config as Partial<Config> | undefined) ?? {}),
    userConfig
  );

  const env = process.env;

  if (env['LLM_FW_PROXY_PORT']) {
    config.proxy.port = parseInt(env['LLM_FW_PROXY_PORT'], 10);
  }
  if (env['LLM_FW_PROXY_MODE']) {
    config.proxy.mode = env['LLM_FW_PROXY_MODE'] as 'proxy' | 'sinkhole';
  }
  if (env['LLM_FW_PROXY_BIND']) {
    config.proxy.bindHost = env['LLM_FW_PROXY_BIND'];
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
  if (env['LLM_FW_JUDGE_UNLESS_BENIGN']) {
    config.detection.judgeUnlessBenign = env['LLM_FW_JUDGE_UNLESS_BENIGN'] === 'true';
  }
  if (env['LLM_FW_TAINT_ENABLED'] && config.taint) {
    config.taint.enabled = env['LLM_FW_TAINT_ENABLED'] === 'true';
  }
  if (env['LLM_FW_TAINT_MODE'] && config.taint && (env['LLM_FW_TAINT_MODE'] === 'audit' || env['LLM_FW_TAINT_MODE'] === 'block')) {
    config.taint.mode = env['LLM_FW_TAINT_MODE'];
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
  if (env['LLM_FW_DASHBOARD_BIND']) {
    config.dashboard.bindHost = env['LLM_FW_DASHBOARD_BIND'];
  }
  if (env['LLM_FW_DASHBOARD_TOKEN']) {
    config.dashboard.authToken = env['LLM_FW_DASHBOARD_TOKEN'];
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
  if (env['LLM_FW_MCP_ENABLED']) {
    config.mcp.enabled = env['LLM_FW_MCP_ENABLED'] === 'true';
  }
  if (env['LLM_FW_MCP_GUARDRAILS_ENABLED']) {
    config.mcp.guardrailsEnabled = env['LLM_FW_MCP_GUARDRAILS_ENABLED'] === 'true';
  }
  if (env['LLM_FW_ASCII_SMUGGLING_ENABLED'] && config.asciiSmuggling) {
    config.asciiSmuggling.enabled = env['LLM_FW_ASCII_SMUGGLING_ENABLED'] === 'true';
  }
  if (env['LLM_FW_RESPONSE_SCAN_ENABLED'] && config.responseScan) {
    config.responseScan.enabled = env['LLM_FW_RESPONSE_SCAN_ENABLED'] === 'true';
  }
  if (env['LLM_FW_RESPONSE_SCAN_MODE'] && config.responseScan && (env['LLM_FW_RESPONSE_SCAN_MODE'] === 'block' || env['LLM_FW_RESPONSE_SCAN_MODE'] === 'audit')) {
    config.responseScan.mode = env['LLM_FW_RESPONSE_SCAN_MODE'];
  }
  if (env['LLM_FW_NONTEXT_ENABLED'] && config.nonText) {
    config.nonText.enabled = env['LLM_FW_NONTEXT_ENABLED'] === 'true';
  }
  if (env['LLM_FW_NONTEXT_MODE'] && config.nonText && (env['LLM_FW_NONTEXT_MODE'] === 'audit' || env['LLM_FW_NONTEXT_MODE'] === 'block')) {
    config.nonText.mode = env['LLM_FW_NONTEXT_MODE'];
  }

  return config;
}
