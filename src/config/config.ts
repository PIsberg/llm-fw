import { Config } from '../types.js';
import { cosmiconfig } from 'cosmiconfig';
import { AI_PROVIDER_HOSTS, AI_PROVIDER_DOMAINS, AI_PROVIDER_INTERCEPT_DOMAINS } from './providers.js';
import { getLlmFwDir } from './paths.js';

export const DEFAULT_CONFIG: Config = {
  proxy: {
    mode: 'proxy',
    // Fail-safe pass-through. OFF by default. Flip on (LLM_FW_BYPASS=true) to turn
    // the proxy into a transparent tunnel — no interception, no blocking — so a bad
    // detection change can never lock the operator out of their LLM APIs.
    bypass: false,
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
    // Tenant/regional API domain suffixes the proxy TLS-intercepts in
    // addition to `targets`. Sourced from the provider registry.
    interceptDomains: AI_PROVIDER_INTERCEPT_DOMAINS,
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
    // Tuned for multilingual-e5-small against the canonical anchor set
    // (data/semantic-anchors.json). E5 runs a higher baseline cosine than the
    // previous model but separates cleanly: across 20+ languages, injections
    // land ~0.85–0.89 to an anchor while benign tops out ~0.85 (the lone
    // exception being injection-ADJACENT benign like "ignore the typos in my
    // draft", which no cosine threshold can distinguish from "ignore your
    // instructions"). 0.86 blocks confident cross-lingual injections while
    // keeping benign false positives to the irreducible adjacent cases; the
    // 0.80–0.86 warn band routes ambiguous prompts to the judge when enabled.
    // The hand-coded heuristics (now covering CJK/Cyrillic/Arabic correctly)
    // catch the common languages at Stage 1; this anchor stage generalizes to
    // the long tail of languages with no hand-written rules.
    embeddingBlockThreshold: 0.86,
    embeddingWarnThreshold: 0.80,
    // Contrastive margin (nearest-injection − nearest-benign). Measured
    // separation: benign agentic commands land ≤ 0 (closer to benign anchors),
    // cross-lingual injections land ≥ +0.055, English injections ≥ +0.017 (and
    // are heuristic-covered anyway). 0.02 clears the benign cluster with room to
    // spare while keeping the cross-lingual recall the embedding stage exists for.
    embeddingMarginThreshold: 0.02,
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
    ollamaUrl: 'http://localhost:11434',
    // Trained ONNX injection classifier — a learned generalization layer that
    // closes the novel-phrasing gap the regex/embedding stages leave open,
    // without the generative judge's false-positive blow-up. Opt-in (~700 MB
    // model). Enable via config or LLM_FW_CLASSIFIER_ENABLED, then it downloads
    // on next start. 0.9 keeps it high-precision; lower it for more recall.
    classifier: {
      enabled: false,
      blockThreshold: 0.9,
      // Gray-zone floor (Option B): scores in [0.5, 0.9) are not blocked outright
      // but are escalated to the Stage 3 judge (when enabled) for a second
      // opinion rather than passed silently. Override via LLM_FW_CLASSIFIER_ESCALATE.
      escalateThreshold: 0.5,
    },
    judgeUnlessBenign: false,
    // Intent-vs-mention suppressor for the classifier: when a prompt only QUOTES /
    // translates / documents / fictionalizes injection content (rather than issuing
    // it), downgrade a classifier block to a warn. ON by default but inert unless
    // the opt-in classifier is enabled. Also LLM_FW_INTENT_MENTION_ENABLED.
    intentMention: true,
    // Operator false-positive suppression list (see suppressions.ts). ON by
    // default — the list is empty until an operator marks a block as a false
    // positive from the dashboard, so this is behavior-preserving out of the
    // box. Also LLM_FW_SUPPRESSIONS_ENABLED.
    suppressions: true,
    // Trusted by default: the system prompt is developer-authored and naturally
    // contains instruction-management language that injection heuristics flag, so
    // scanning it blocks legitimate traffic. Enable only when untrusted data is
    // mixed into the system prompt. Also LLM_FW_SCAN_SYSTEM_PROMPT.
    scanSystemPrompt: false,
  },
  dashboard: {
    port: 7731,
    maxEvents: 100,
    bindHost: '127.0.0.1',
  },
  dlp: {
    enabled: true,
    mode: 'redact',
    detectors: [
      // cloud providers
      'aws', 'google', 'azure', 'digitalocean',
      // AI / LLM service providers
      'openai', 'anthropic', 'openrouter', 'groq', 'xai', 'perplexity',
      'huggingface', 'replicate', 'fireworks', 'nvidia', 'anyscale', 'langsmith',
      // source control, package registries, CI/CD & infra ops
      'github', 'gitlab', 'npm', 'pypi', 'rubygems', 'dockerhub', 'vault',
      'terraform', 'databricks', 'atlassian', 'newrelic', 'sentry',
      // payment, commerce, communications, email/SMS
      'stripe', 'square', 'shopify', 'slack', 'discord', 'telegram',
      'twilio', 'sendgrid', 'mailgun', 'mailchimp',
      // key formats, connection strings, generics
      'private_keys', 'mongodb', 'connection_uri', 'jwt', 'entropy', 'pii',
    ],
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
    harmfulCompliance: true,
  },
  // Non-text content blocks (issue #60). Text-bearing payloads (text/* docs,
  // JSON, data-URL files, PDFs with uncompressed text) are decoded and scanned
  // like prompts. Opaque media (raster images, audio) can't be inspected
  // locally: audit (default) surfaces a warn event so it's no longer
  // invisible; block refuses requests carrying uninspectable content.
  nonText: {
    enabled: true,
    mode: 'audit',
    ocr: false,
  },
  // Many-shot jailbreaking (issue: structural in-context conditioning). A long
  // run of fabricated dialogue turns alone warns; a block requires ≥2 faux
  // assistant turns demonstrating harmful compliance, which benign pasted
  // transcripts don't have. minTurns 8 ≈ 4 Q/A pairs — abnormal for inline
  // content but low enough to catch scaled-down proofs of concept.
  manyShot: {
    enabled: true,
    minTurns: 8,
    harmfulComplianceThreshold: 2,
    mode: 'block',
  },
  // Multi-turn crescendo. Blocks when a 3+ user-turn conversation ends on a
  // boundary-pushing escalation directive AND earlier turns reference concrete
  // harmful content — analyzed within the request (LLM APIs resend the whole
  // conversation), so no session state is needed.
  crescendo: {
    enabled: true,
    minUserTurns: 3,
    mode: 'block',
  },
  // Indirect prompt injection — an imperative action-instruction planted in
  // tool/document output (InjecAgent's threat model; the primary agentic
  // vector). On by default in block mode: it runs ONLY on the tool_result /
  // document surfaces, where a second-person imperative to perform a sensitive
  // side-effecting action (move money, grant access, exfiltrate to an address)
  // has no legitimate origin, so precision is high.
  indirectInstruction: {
    enabled: true,
    mode: 'block',
  },
  // Harmful-request content moderation — requests for weapon/drug synthesis,
  // intrusion how-tos, fraud, or hateful/defamatory content. The firewall is
  // injection-first (harmful content is a secondary threat model), but these
  // requests sail past the injection-specific stages, so a tightly precision-
  // gated input-side check is on by default. Disable for a pure injection
  // firewall (config or LLM_FW_HARMFUL_REQUEST_ENABLED=false).
  harmfulRequest: {
    enabled: true,
    mode: 'block',
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
  extraTargets: [],
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
    const p = path.join(getLlmFwDir(), 'config.json');
    userConfig = JSON.parse(readFileSync(p, 'utf8')) as Partial<Config>;
  } catch { /* not present */ }

  let config = deepMerge<Config>(
    deepMerge<Config>(DEFAULT_CONFIG, (found?.config as Partial<Config> | undefined) ?? {}),
    userConfig
  );

  for (const [key, apply] of Object.entries(ENV_OVERRIDES)) {
    const value = process.env[key];
    if (value) apply(config, value);
  }

  // extraTargets is the additive path: appended (deduplicated) to targets so a
  // self-hosted endpoint can be covered without redeclaring the built-in
  // registry. Applied last so it sees env-supplied entries too.
  if (config.extraTargets?.length) {
    config.targets = [...new Set([...config.targets, ...config.extraTargets])];
  }

  return config;
}

/** Parse a comma-separated env value into a trimmed, non-empty string list. */
function splitList(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * LLM_FW_* environment overrides, applied last (over file configs). Each entry
 * parses the raw string and writes the typed value; entries for optional
 * config sections guard against the section having been nulled out by a file
 * config, and enum-valued settings ignore values outside their domain.
 */
const ENV_OVERRIDES: Record<string, (config: Config, value: string) => void> = {
  LLM_FW_PROXY_PORT: (c, v) => { c.proxy.port = parseInt(v, 10); },
  LLM_FW_PROXY_MODE: (c, v) => { c.proxy.mode = v as 'proxy' | 'sinkhole'; },
  LLM_FW_BYPASS: (c, v) => { c.proxy.bypass = v === 'true'; },
  LLM_FW_PROXY_BIND: (c, v) => { c.proxy.bindHost = v; },
  LLM_FW_HTTPS_PORT: (c, v) => { c.proxy.httpsPort = parseInt(v, 10); },
  LLM_FW_MAX_BODY_BYTES: (c, v) => { c.proxy.maxBodyBytes = parseInt(v, 10); },
  LLM_FW_JUDGE_ENABLED: (c, v) => { c.detection.judgeEnabled = v === 'true'; },
  LLM_FW_JUDGE_BLOCK: (c, v) => { c.detection.judgeBlock = v === 'true'; },
  LLM_FW_JUDGE_UNLESS_BENIGN: (c, v) => { c.detection.judgeUnlessBenign = v === 'true'; },
  LLM_FW_SCAN_SYSTEM_PROMPT: (c, v) => { c.detection.scanSystemPrompt = v === 'true'; },
  LLM_FW_EMBEDDING_MARGIN: (c, v) => { const n = parseFloat(v); if (!Number.isNaN(n)) c.detection.embeddingMarginThreshold = n; },
  LLM_FW_JUDGE_MODEL: (c, v) => { c.detection.judgeModel = v; },
  LLM_FW_OLLAMA_URL: (c, v) => { c.detection.ollamaUrl = v; },
  LLM_FW_CLASSIFIER_ENABLED: (c, v) => { if (c.detection.classifier) c.detection.classifier.enabled = v === 'true'; },
  LLM_FW_CLASSIFIER_THRESHOLD: (c, v) => { if (c.detection.classifier) c.detection.classifier.blockThreshold = parseFloat(v); },
  LLM_FW_CLASSIFIER_ESCALATE: (c, v) => { const n = parseFloat(v); if (!Number.isNaN(n) && c.detection.classifier) c.detection.classifier.escalateThreshold = n; },
  LLM_FW_INTENT_MENTION_ENABLED: (c, v) => { c.detection.intentMention = v === 'true'; },
  LLM_FW_SUPPRESSIONS_ENABLED: (c, v) => { c.detection.suppressions = v === 'true'; },
  LLM_FW_EMBEDDING_BLOCK_THRESHOLD: (c, v) => { c.detection.embeddingBlockThreshold = parseFloat(v); },
  LLM_FW_EMBEDDING_WARN_THRESHOLD: (c, v) => { c.detection.embeddingWarnThreshold = parseFloat(v); },
  LLM_FW_TAINT_ENABLED: (c, v) => { if (c.taint) c.taint.enabled = v === 'true'; },
  LLM_FW_TAINT_MODE: (c, v) => { if (c.taint && (v === 'audit' || v === 'block')) c.taint.mode = v; },
  LLM_FW_DASHBOARD_PORT: (c, v) => { c.dashboard.port = parseInt(v, 10); },
  LLM_FW_DASHBOARD_BIND: (c, v) => { c.dashboard.bindHost = v; },
  LLM_FW_DASHBOARD_TOKEN: (c, v) => { c.dashboard.authToken = v; },
  LLM_FW_DLP_ENABLED: (c, v) => { c.dlp.enabled = v === 'true'; },
  LLM_FW_DLP_MODE: (c, v) => { c.dlp.mode = v as 'block' | 'redact' | 'audit'; },
  LLM_FW_DOS_ENABLED: (c, v) => { c.dos.enabled = v === 'true'; },
  LLM_FW_DOS_MAX_RPM: (c, v) => { c.dos.maxRequestsPerMinute = parseInt(v, 10); },
  LLM_FW_DOS_MAX_TOKENS_PER_SESSION: (c, v) => { c.dos.maxTokensPerSession = parseInt(v, 10); },
  LLM_FW_DOS_TOKEN_WINDOW_MS: (c, v) => { c.dos.tokenBudgetWindowMs = parseInt(v, 10); },
  LLM_FW_RAG_ENABLED: (c, v) => { c.rag.enabled = v === 'true'; },
  LLM_FW_MCP_ENABLED: (c, v) => { c.mcp.enabled = v === 'true'; },
  LLM_FW_MCP_GUARDRAILS_ENABLED: (c, v) => { c.mcp.guardrailsEnabled = v === 'true'; },
  LLM_FW_ASCII_SMUGGLING_ENABLED: (c, v) => { if (c.asciiSmuggling) c.asciiSmuggling.enabled = v === 'true'; },
  LLM_FW_RESPONSE_SCAN_ENABLED: (c, v) => { if (c.responseScan) c.responseScan.enabled = v === 'true'; },
  LLM_FW_RESPONSE_SCAN_MODE: (c, v) => { if (c.responseScan && (v === 'block' || v === 'audit')) c.responseScan.mode = v; },
  LLM_FW_RESPONSE_HARM_ENABLED: (c, v) => { if (c.responseScan) c.responseScan.harmfulCompliance = v === 'true'; },
  LLM_FW_NONTEXT_ENABLED: (c, v) => { if (c.nonText) c.nonText.enabled = v === 'true'; },
  LLM_FW_NONTEXT_MODE: (c, v) => { if (c.nonText && (v === 'audit' || v === 'block')) c.nonText.mode = v; },
  LLM_FW_NONTEXT_OCR: (c, v) => { if (c.nonText) c.nonText.ocr = v === 'true'; },
  LLM_FW_MANYSHOT_ENABLED: (c, v) => { if (c.manyShot) c.manyShot.enabled = v === 'true'; },
  LLM_FW_MANYSHOT_MODE: (c, v) => { if (c.manyShot && (v === 'audit' || v === 'block')) c.manyShot.mode = v; },
  LLM_FW_CRESCENDO_ENABLED: (c, v) => { if (c.crescendo) c.crescendo.enabled = v === 'true'; },
  LLM_FW_CRESCENDO_MODE: (c, v) => { if (c.crescendo && (v === 'audit' || v === 'block')) c.crescendo.mode = v; },
  LLM_FW_INDIRECT_INSTRUCTION_ENABLED: (c, v) => { if (c.indirectInstruction) c.indirectInstruction.enabled = v === 'true'; },
  LLM_FW_INDIRECT_INSTRUCTION_MODE: (c, v) => { if (c.indirectInstruction && (v === 'audit' || v === 'block')) c.indirectInstruction.mode = v; },
  LLM_FW_HARMFUL_REQUEST_ENABLED: (c, v) => { if (c.harmfulRequest) c.harmfulRequest.enabled = v === 'true'; },
  LLM_FW_HARMFUL_REQUEST_MODE: (c, v) => { if (c.harmfulRequest && (v === 'audit' || v === 'block')) c.harmfulRequest.mode = v; },
  LLM_FW_EXTRA_TARGETS: (c, v) => { c.extraTargets = [...(c.extraTargets ?? []), ...splitList(v)]; },
  LLM_FW_INTERCEPT_DOMAINS: (c, v) => { c.proxy.interceptDomains = splitList(v); },
};
