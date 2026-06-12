/**
 * Canonical registry of LLM/AI service providers.
 *
 * This is the single source of truth that makes llm-fw "just work" with every
 * major AI service. It drives three things at once:
 *   1. `targets`            — hostnames the proxy TLS-intercepts/inspects and the
 *                             sinkhole redirects via the hosts file.
 *   2. `urlFilter` allowlist — domains the outbound URL filter treats as known-good.
 *   3. `identifyService`    — the human-readable service label shown on the
 *                             dashboard Live Traffic tab.
 *
 * Adding a provider here is all that is needed for the firewall to cover it.
 *
 * `hosts` are the concrete API hostnames (a hosts-file sinkhole entry needs a
 * concrete name — it cannot wildcard). `domains` are suffixes used for proxy-mode
 * matching and traffic labelling, so regional/tenant subdomains
 * (e.g. `my-resource.openai.azure.com`) are covered without enumerating them.
 *
 * Almost every provider below speaks the OpenAI-compatible `/chat/completions`
 * wire format, so a single OpenAIParser covers the bulk of them — see parsers.ts.
 */
export interface AiProvider {
  name: string
  /** Concrete API hostnames to intercept (sinkhole hosts-file + proxy inspection). */
  hosts: string[]
  /** Domain suffixes for proxy-mode matching + traffic labels. Defaults to `hosts`. */
  domains?: string[]
}

export const AI_PROVIDERS: AiProvider[] = [
  { name: 'OpenAI', hosts: ['api.openai.com'], domains: ['openai.com', 'openai.azure.com'] },
  { name: 'Anthropic', hosts: ['api.anthropic.com'], domains: ['anthropic.com'] },
  {
    name: 'Google',
    hosts: ['generativelanguage.googleapis.com', 'aiplatform.googleapis.com'],
    domains: ['googleapis.com', 'google.com', 'googleusercontent.com'],
  },
  { name: 'Mistral', hosts: ['api.mistral.ai'], domains: ['mistral.ai'] },
  { name: 'Groq', hosts: ['api.groq.com'], domains: ['groq.com'] },
  { name: 'OpenRouter', hosts: ['openrouter.ai'], domains: ['openrouter.ai'] },
  { name: 'Together', hosts: ['api.together.xyz', 'api.together.ai'], domains: ['together.xyz', 'together.ai'] },
  { name: 'Fireworks', hosts: ['api.fireworks.ai'], domains: ['fireworks.ai'] },
  { name: 'DeepSeek', hosts: ['api.deepseek.com'], domains: ['deepseek.com'] },
  { name: 'xAI', hosts: ['api.x.ai'], domains: ['x.ai'] },
  { name: 'Perplexity', hosts: ['api.perplexity.ai'], domains: ['perplexity.ai'] },
  { name: 'Cohere', hosts: ['api.cohere.com', 'api.cohere.ai'], domains: ['cohere.com', 'cohere.ai'] },
  { name: 'Anyscale', hosts: ['api.endpoints.anyscale.com'], domains: ['anyscale.com'] },
  {
    name: 'AWS Bedrock',
    // The region sits mid-hostname, so a suffix can't cover it: the major
    // regions are enumerated as concrete hosts (sinkhole + proxy intercept)
    // and the wildcard domain labels every other region on the dashboard.
    hosts: [
      'bedrock-runtime.us-east-1.amazonaws.com',
      'bedrock-runtime.us-east-2.amazonaws.com',
      'bedrock-runtime.us-west-2.amazonaws.com',
      'bedrock-runtime.eu-west-1.amazonaws.com',
      'bedrock-runtime.eu-west-2.amazonaws.com',
      'bedrock-runtime.eu-central-1.amazonaws.com',
      'bedrock-runtime.ap-southeast-1.amazonaws.com',
      'bedrock-runtime.ap-southeast-2.amazonaws.com',
      'bedrock-runtime.ap-northeast-1.amazonaws.com',
      'bedrock-runtime.ap-south-1.amazonaws.com',
    ],
    domains: ['bedrock-runtime.*.amazonaws.com'],
  },
  // router.huggingface.co is the current Inference Providers endpoint
  // (OpenAI-compatible); api-inference.huggingface.co is the deprecated legacy
  // host, kept so older SDKs are still sinkholed.
  {
    name: 'HuggingFace',
    hosts: ['router.huggingface.co', 'api-inference.huggingface.co'],
    domains: ['huggingface.co'],
  },
]

/** Infrastructure / tooling hosts — labelled on the dashboard but never sinkholed. */
const INFRA_SERVICES: { name: string; domains: string[] }[] = [
  { name: 'NPM', domains: ['npmjs.org', 'npmjs.com'] },
  { name: 'GitHub', domains: ['github.com'] },
  { name: 'Microsoft', domains: ['microsoft.com', 'exp-tas.com'] },
  { name: 'Antigravity', domains: ['antigravity-unleash.goog'] },
]

/** Concrete API hostnames — the default `targets` (sinkhole + proxy inspection). */
export const AI_PROVIDER_HOSTS: string[] = [...new Set(AI_PROVIDERS.flatMap(p => p.hosts))]

/**
 * Domain suffixes for the outbound URL filter allowlist. Concrete hosts are
 * included alongside the suffixes: for providers like Bedrock the only
 * domain entry is a mid-name wildcard, which the URL filter's plain
 * suffix-set matching cannot evaluate — the concrete hosts cover it there.
 */
export const AI_PROVIDER_DOMAINS: string[] = [
  ...new Set(AI_PROVIDERS.flatMap(p => [...(p.domains ?? []), ...p.hosts])),
]

function matchesDomain(hostname: string, domain: string): boolean {
  const star = domain.indexOf('*')
  if (star !== -1) {
    // Single-wildcard pattern (e.g. 'bedrock-runtime.*.amazonaws.com') for
    // hostnames whose variable segment sits mid-name, where suffix matching
    // can't help. The wildcard matches exactly one non-empty label.
    const prefix = domain.slice(0, star)
    const suffix = domain.slice(star + 1)
    if (!hostname.startsWith(prefix) || !hostname.endsWith(suffix)) return false
    const middle = hostname.slice(prefix.length, hostname.length - suffix.length)
    return middle.length > 0 && !middle.includes('.')
  }
  return hostname === domain || hostname.endsWith('.' + domain)
}

/**
 * Map a hostname to a human-readable service label for the dashboard.
 * AI providers take precedence over infra; private/loopback addresses are `Local`.
 */
export function identifyService(hostname: string): string {
  for (const p of AI_PROVIDERS) {
    for (const d of p.domains ?? p.hosts) {
      if (matchesDomain(hostname, d)) return p.name
    }
  }
  for (const s of INFRA_SERVICES) {
    for (const d of s.domains) {
      if (matchesDomain(hostname, d)) return s.name
    }
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) {
    return 'Local'
  }
  return 'Custom'
}
