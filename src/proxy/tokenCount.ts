// Token-counting requests (GHSA-9986-fxc2-cx83).
//
// Each provider llm-fw parses offers an endpoint that counts the tokens of a
// request without running it, and takes the same conversation: Claude Code
// calls Anthropic's during a session. None of them has a payload parser, and
// DLP ran only on parsed requests, so a secret redacted from the Messages
// request reached the provider in clear in the count beside it. DLP now scans
// these as it scans a Messages request. Injection detection does not: nothing
// is generated from them.

/** True for a provider's token-counting endpoint (query string ignored). */
export function isTokenCountRequest(path: string): boolean {
  const p = path.split('?')[0] ?? ''
  return p === '/v1/messages/count_tokens' // Anthropic
    || p.endsWith('/responses/input_tokens') // OpenAI Responses
    || /\/models\/[^/]+:countTokens$/.test(p) // Gemini, Vertex AI
}
