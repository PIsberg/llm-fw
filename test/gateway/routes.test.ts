import { describe, it, expect } from 'vitest'
import { BUILTIN_PROVIDERS, resolveRoute, applyUpstreamAuth, stripCredentialQuery, upstreamHostHeader, type GatewayRoute } from '../../src/gateway/routes.js'

const opts = { defaultProvider: 'openai', providers: BUILTIN_PROVIDERS }

describe('resolveRoute — prefixed paths', () => {
  it('routes /anthropic/v1/messages and strips the prefix', () => {
    const route = resolveRoute('/anthropic/v1/messages', opts)
    expect(route?.provider.host).toBe('api.anthropic.com')
    expect(route?.upstreamPath).toBe('/v1/messages')
  })

  it('routes any provider slug', () => {
    expect(resolveRoute('/groq/v1/chat/completions', opts)?.provider.host).toBe('api.groq.com')
    expect(resolveRoute('/mistral/v1/chat/completions', opts)?.provider.host).toBe('api.mistral.ai')
  })

  it('is case-insensitive on the slug', () => {
    expect(resolveRoute('/Anthropic/v1/messages', opts)?.slug).toBe('anthropic')
  })
})

describe('resolveRoute — bare provider-shaped paths', () => {
  it('routes /v1/messages to Anthropic regardless of the default', () => {
    const route = resolveRoute('/v1/messages', { ...opts, defaultProvider: 'groq' })
    expect(route?.slug).toBe('anthropic')
    expect(route?.upstreamPath).toBe('/v1/messages')
  })

  it('routes Gemini model paths to Google', () => {
    expect(resolveRoute('/v1beta/models/gemini-pro:generateContent', opts)?.slug).toBe('gemini')
    expect(resolveRoute('/v1/models/gemini-pro:streamGenerateContent', opts)?.slug).toBe('gemini')
  })

  it('leaves OpenAI-shaped /v1/models/{id} with the default provider', () => {
    // `/v1/models/{id}` is OpenAI's model-retrieval endpoint, cloned by Groq,
    // OpenRouter, Together and every OpenAI-compatible self-hosted endpoint.
    // Claiming the whole `/v1/models/` prefix for Gemini sent an ordinary
    // `GET /v1/models/gpt-4o` to generativelanguage.googleapis.com — and with
    // key custody off for that route, the caller's own provider credential
    // went with it. Only the `:method` suffix marks a /v1/models path as
    // Gemini's.
    expect(resolveRoute('/v1/models/gpt-4o', opts)?.slug).toBe('openai')
    expect(resolveRoute('/v1/models', opts)?.slug).toBe('openai')
    // Fine-tune ids are colon-delimited too, so the discriminator has to be
    // Gemini's actual method names, not "ends with a colon-word".
    expect(resolveRoute('/v1/models/ft:gpt-4o:acme:abcdef', { ...opts, defaultProvider: 'groq' })?.slug).toBe('groq')
  })

  it('sends OpenAI-compatible paths to the configured default', () => {
    expect(resolveRoute('/v1/chat/completions', opts)?.slug).toBe('openai')
    expect(resolveRoute('/v1/chat/completions', { ...opts, defaultProvider: 'groq' })?.slug).toBe('groq')
  })

  it('preserves the full path when routing by default provider', () => {
    expect(resolveRoute('/v1/embeddings', opts)?.upstreamPath).toBe('/v1/embeddings')
  })
})

describe('resolveRoute — no match', () => {
  it('refuses a path outside /v1 rather than guessing an upstream', () => {
    expect(resolveRoute('/', opts)).toBeNull()
    expect(resolveRoute('/admin', opts)).toBeNull()
    expect(resolveRoute('/wp-login.php', opts)).toBeNull()
  })

  it('refuses an unknown slug', () => {
    expect(resolveRoute('/nosuchprovider/v1/chat/completions', opts)).toBeNull()
  })

  it('refuses when the configured default provider does not exist', () => {
    expect(resolveRoute('/v1/chat/completions', { ...opts, defaultProvider: 'typo' })).toBeNull()
  })
})

describe('applyUpstreamAuth', () => {
  const route = (slug: keyof typeof BUILTIN_PROVIDERS): GatewayRoute =>
    ({ slug, provider: BUILTIN_PROVIDERS[slug]!, upstreamPath: '/v1/x' })

  it('leaves the client credential alone when the operator holds no key', () => {
    const headers = { authorization: 'Bearer sk-client' }
    expect(applyUpstreamAuth(headers, route('openai'), undefined)).toEqual(headers)
  })

  it('replaces the client credential with the operator key', () => {
    const out = applyUpstreamAuth({ authorization: 'Bearer sk-client' }, route('openai'), 'sk-operator')
    expect(out['authorization']).toBe('Bearer sk-operator')
  })

  it('uses each provider header style', () => {
    expect(applyUpstreamAuth({}, route('anthropic'), 'k')['x-api-key']).toBe('k')
    expect(applyUpstreamAuth({}, route('gemini'), 'k')['x-goog-api-key']).toBe('k')
    expect(applyUpstreamAuth({}, route('openai'), 'k')['authorization']).toBe('Bearer k')
  })

  it('strips every other credential header it did not set', () => {
    // Otherwise a caller could keep reaching the provider on their own key,
    // bypassing the operator's attribution and quota.
    const out = applyUpstreamAuth(
      { authorization: 'Bearer sk-client', 'x-api-key': 'sk-client2', 'api-key': 'sk-client3', 'x-goog-api-key': 'sk-client4' },
      route('anthropic'),
      'sk-operator',
    )
    expect(out['x-api-key']).toBe('sk-operator')
    expect(out['authorization']).toBeUndefined()
    expect(out['api-key']).toBeUndefined()
    expect(out['x-goog-api-key']).toBeUndefined()
  })

  it('does not mutate the headers it was given', () => {
    const headers = { authorization: 'Bearer sk-client' }
    applyUpstreamAuth(headers, route('openai'), 'sk-operator')
    expect(headers.authorization).toBe('Bearer sk-client')
  })
})

describe('stripCredentialQuery', () => {
  it('removes the credential parameters a provider accepts in the URL', () => {
    // Google's REST API takes its key as `?key=` and Azure OpenAI accepts
    // `?api-key=`, so header-only custody leaves the caller a way to reach the
    // provider on their own credential.
    expect(stripCredentialQuery('?key=sk-caller')).toBe('')
    expect(stripCredentialQuery('?api-key=sk-caller')).toBe('')
    expect(stripCredentialQuery('?api_key=sk-caller')).toBe('')
    expect(stripCredentialQuery('?access_token=sk-caller')).toBe('')
  })

  it('keeps the parameters that are not credentials', () => {
    expect(stripCredentialQuery('?alt=sse&key=sk-caller')).toBe('?alt=sse')
    expect(stripCredentialQuery('?key=sk-caller&alt=sse')).toBe('?alt=sse')
  })

  it('leaves a query with no credential byte-for-byte alone', () => {
    // Rebuilding through URLSearchParams would re-encode ':' and '+', which an
    // upstream may treat as a different value.
    const q = '?model=ft:gpt-4o:acme&filter=a+b%3Ac'
    expect(stripCredentialQuery(q)).toBe(q)
    expect(stripCredentialQuery('')).toBe('')
  })

  it('matches the parameter name case-insensitively', () => {
    expect(stripCredentialQuery('?KEY=sk-caller&alt=sse')).toBe('?alt=sse')
  })
})

describe('upstreamHostHeader', () => {
  it('omits the port when it is the scheme default', () => {
    expect(upstreamHostHeader({ name: 'x', host: 'api.openai.com', auth: 'bearer' })).toBe('api.openai.com')
    expect(upstreamHostHeader({ name: 'x', host: 'h', auth: 'bearer', port: 443 })).toBe('h')
    expect(upstreamHostHeader({ name: 'x', host: 'h', auth: 'bearer', protocol: 'http', port: 80 })).toBe('h')
  })

  it('carries a non-default port', () => {
    // The documented private-endpoint case: a self-hosted vLLM on :8000 behind
    // anything that routes on Host sees the wrong virtual host without it.
    expect(upstreamHostHeader({ name: 'x', host: 'vllm.svc.cluster.local', auth: 'bearer', protocol: 'http', port: 8000 }))
      .toBe('vllm.svc.cluster.local:8000')
  })

  it('brackets an IPv6 literal', () => {
    expect(upstreamHostHeader({ name: 'x', host: '::1', auth: 'bearer', protocol: 'http', port: 8000 })).toBe('[::1]:8000')
    expect(upstreamHostHeader({ name: 'x', host: '[::1]', auth: 'bearer', protocol: 'http', port: 8000 })).toBe('[::1]:8000')
  })
})
