/**
 * Gateway routing: turn an inbound request path into an upstream provider call.
 *
 * The forward-proxy deployment requires every client machine to install the
 * firewall's CA, because it works by intercepting TLS to the real provider
 * host. That is a hard sell in a company and impossible in most CI containers
 * and serverless runtimes. The gateway removes it: clients point their SDK's
 * `base_url` at the firewall and speak ordinary HTTPS to a certificate the
 * operator already owns.
 *
 * Two path shapes are accepted:
 *
 *   1. Prefixed  — `/anthropic/v1/messages`, `/openai/v1/chat/completions`.
 *      Explicit, unambiguous, and lets one gateway front every provider.
 *   2. Bare      — `/v1/messages`, `/v1/chat/completions`.
 *      Lets an SDK point at `https://fw.example.com` with no path rewriting.
 *      `/v1/messages` is Anthropic-specific so it routes on its own;
 *      OpenAI-compatible paths route to `defaultProvider`, which is what makes
 *      a company running Groq or a self-hosted vLLM work unchanged.
 */

/** How a provider expects its API key to be presented. */
export type UpstreamAuthStyle = 'bearer' | 'x-api-key' | 'x-goog-api-key';

export interface GatewayProvider {
  /** Registry name, matching src/config/providers.ts, for event labelling. */
  name: string;
  host: string;
  auth: UpstreamAuthStyle;
  /** Upstream port. Defaults to 443 (or 80 when protocol is http). */
  port?: number;
  /**
   * Upstream scheme. 'https' for every public provider. 'http' exists for
   * in-cluster endpoints — a self-hosted vLLM or Ollama reached over a private
   * network where TLS is terminated elsewhere.
   */
  protocol?: 'https' | 'http';
}

/**
 * Built-in provider slugs. Every entry here is reachable as `/<slug>/…` with no
 * configuration; `gateway.providers` in the config adds private endpoints
 * (self-hosted vLLM, a regional Azure resource) or overrides a host.
 */
export const BUILTIN_PROVIDERS: Record<string, GatewayProvider> = {
  anthropic: { name: 'Anthropic', host: 'api.anthropic.com', auth: 'x-api-key' },
  openai: { name: 'OpenAI', host: 'api.openai.com', auth: 'bearer' },
  gemini: { name: 'Google', host: 'generativelanguage.googleapis.com', auth: 'x-goog-api-key' },
  vertex: { name: 'Google', host: 'aiplatform.googleapis.com', auth: 'bearer' },
  mistral: { name: 'Mistral', host: 'api.mistral.ai', auth: 'bearer' },
  groq: { name: 'Groq', host: 'api.groq.com', auth: 'bearer' },
  openrouter: { name: 'OpenRouter', host: 'openrouter.ai', auth: 'bearer' },
  together: { name: 'Together', host: 'api.together.xyz', auth: 'bearer' },
  fireworks: { name: 'Fireworks', host: 'api.fireworks.ai', auth: 'bearer' },
  deepseek: { name: 'DeepSeek', host: 'api.deepseek.com', auth: 'bearer' },
  xai: { name: 'xAI', host: 'api.x.ai', auth: 'bearer' },
  perplexity: { name: 'Perplexity', host: 'api.perplexity.ai', auth: 'bearer' },
  cohere: { name: 'Cohere', host: 'api.cohere.com', auth: 'bearer' },
  huggingface: { name: 'HuggingFace', host: 'router.huggingface.co', auth: 'bearer' },
};

export interface GatewayRoute {
  slug: string;
  provider: GatewayProvider;
  /** Path to request upstream, with the routing prefix removed. */
  upstreamPath: string;
}

/**
 * Bare paths that identify exactly one provider regardless of the configured
 * default.
 *
 * `/v1/messages` is Anthropic's Messages API. For Gemini it is the `/v1beta/`
 * prefix, or a `/v1/models/…` path that carries the `:generateContent`-style
 * method suffix.
 *
 * The suffix is what makes a `/v1/models/` path Gemini's, NOT the prefix:
 * `/v1/models/{id}` is OpenAI's model-retrieval endpoint, cloned by Groq,
 * OpenRouter, Together, Fireworks, DeepSeek, Perplexity and every
 * OpenAI-compatible self-hosted endpoint. Claiming the whole prefix sent an
 * ordinary `GET /v1/models/gpt-4o` to generativelanguage.googleapis.com — and
 * with key custody off for that route, the caller's own provider credential
 * went with it.
 */
/** The `:method` suffixes Gemini's generative endpoints use. */
const GEMINI_METHOD_RE =
  /:(generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents|generateAnswer|predict|generateMessage)$/;

function bareProviderFor(pathname: string): string | null {
  if (pathname === '/v1/messages' || pathname.startsWith('/v1/messages/')) return 'anthropic';
  if (pathname.startsWith('/v1beta/')) return 'gemini';
  // Gemini's v1 shape is /v1/models/<model>:<method>. Match the method names
  // rather than "ends with :something": OpenAI fine-tune ids are themselves
  // colon-delimited (ft:gpt-4o:acme:abcdef), so a generic suffix test would
  // misroute those straight back to Gemini.
  if (pathname.startsWith('/v1/models/') && GEMINI_METHOD_RE.test(pathname)) return 'gemini';
  return null;
}

export interface RouteOptions {
  /** Slug handling bare OpenAI-compatible paths. */
  defaultProvider: string;
  /** Merged built-in + operator-configured providers. */
  providers: Record<string, GatewayProvider>;
}

/**
 * Resolve an inbound request path to an upstream call, or null when no route
 * matches (the caller answers 404 rather than guessing an upstream).
 */
export function resolveRoute(pathname: string, opts: RouteOptions): GatewayRoute | null {
  const providers = opts.providers;

  // 1. Explicit `/<slug>/...` prefix.
  const firstSlash = pathname.indexOf('/', 1);
  if (firstSlash > 1) {
    const slug = pathname.slice(1, firstSlash).toLowerCase();
    const provider = providers[slug];
    if (provider) {
      return { slug, provider, upstreamPath: pathname.slice(firstSlash) || '/' };
    }
  }

  // 2. Bare provider-specific path.
  const bare = bareProviderFor(pathname);
  if (bare) {
    const provider = providers[bare];
    if (provider) return { slug: bare, provider, upstreamPath: pathname };
  }

  // 3. Bare OpenAI-compatible path → the configured default provider. Scoped to
  //    `/v1/…` so an arbitrary path (a typo, a probe, a health check that lost
  //    its route) is a 404 instead of being forwarded to a provider.
  if (pathname.startsWith('/v1/')) {
    const provider = providers[opts.defaultProvider];
    if (provider) return { slug: opts.defaultProvider, provider, upstreamPath: pathname };
  }

  return null;
}

/**
 * Apply the upstream credential to the outbound headers.
 *
 * When the operator has configured a key for the route, the gateway holds the
 * provider credential and the client never sees it: whatever the client sent is
 * REPLACED. This is often the reason a company adopts a gateway at all, so the
 * replacement must be total — leaving a client-supplied `authorization` in
 * place beside an injected `x-api-key` would let a caller reach the provider on
 * their own key and bypass the operator's quota and attribution.
 *
 * With no configured key the client's own credential passes through untouched.
 */
export function applyUpstreamAuth(
  headers: Record<string, string>,
  route: GatewayRoute,
  apiKey: string | undefined,
): Record<string, string> {
  if (!apiKey) return headers;
  const out = { ...headers };
  for (const h of ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']) delete out[h];
  switch (route.provider.auth) {
    case 'bearer': out['authorization'] = `Bearer ${apiKey}`; break;
    case 'x-api-key': out['x-api-key'] = apiKey; break;
    case 'x-goog-api-key': out['x-goog-api-key'] = apiKey; break;
  }
  return out;
}

/**
 * Query parameters that carry a provider credential.
 *
 * Header custody (applyUpstreamAuth) is total, but it is not the whole story:
 * Google's REST API documents its key as `?key=`, Azure OpenAI accepts
 * `?api-key=`, and an OAuth-style endpoint takes `?access_token=`. A caller who
 * puts their own key in the URL therefore reached the provider on that key,
 * with the operator's key sitting unused in a header beside it — the exact
 * bypass of attribution and quota that custody exists to close.
 */
const CREDENTIAL_QUERY_PARAMS = new Set(['key', 'api-key', 'api_key', 'access_token']);

/**
 * Remove credential parameters from an upstream query string, preserving every
 * other parameter byte-for-byte.
 *
 * Deliberately NOT rebuilt through URLSearchParams: that re-encodes what it
 * round-trips, so `?model=ft:gpt-4o:acme` would reach the provider as
 * `?model=ft%3Agpt-4o%3Aacme` and `a+b` would become `a%2Bb`. A gateway must
 * not rewrite a request it has no reason to touch.
 *
 * Only called when the operator holds the key for the route: with custody off
 * the client's own credential is what should reach the provider, in the URL
 * exactly as in the header.
 */
export function stripCredentialQuery(query: string): string {
  if (!query) return query;
  const raw = query.startsWith('?') ? query.slice(1) : query;
  if (!raw) return query;
  const segments = raw.split('&');
  const kept = segments.filter(segment => {
    const name = segment.split('=')[0] ?? '';
    return !CREDENTIAL_QUERY_PARAMS.has(decodeURIComponent(name).toLowerCase());
  });
  if (kept.length === segments.length) return query;
  return kept.length ? '?' + kept.join('&') : '';
}

/**
 * The `Host` header for an upstream call.
 *
 * The port belongs in it whenever it is not the scheme default. The documented
 * private-endpoint shape is `{ host: 'vllm.svc.cluster.local', port: 8000,
 * protocol: 'http' }`, and an ingress, a vhost or any reverse proxy in front of
 * that endpoint routes on Host: given the bare hostname it either 404s or
 * serves a different backend entirely.
 */
export function upstreamHostHeader(provider: GatewayProvider): string {
  const defaultPort = provider.protocol === 'http' ? 80 : 443;
  const port = provider.port ?? defaultPort;
  // An IPv6 literal has to be bracketed before a port can be appended, or
  // `::1` + `:8000` parses as a different address entirely.
  const host = provider.host.includes(':') && !provider.host.startsWith('[')
    ? `[${provider.host}]`
    : provider.host;
  return port === defaultPort ? host : `${host}:${port}`;
}
