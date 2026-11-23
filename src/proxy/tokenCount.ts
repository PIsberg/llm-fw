import { canonicalPath } from '../detection/canonicalPath.js'

// Token-counting requests (GHSA-9986-fxc2-cx83).
//
// Each provider llm-fw parses offers an endpoint that counts the tokens of a
// request without running it, and takes the same conversation: Claude Code
// calls Anthropic's during a session. None of them has a payload parser, and
// DLP ran only on parsed requests, so a secret redacted from the Messages
// request reached the provider in clear in the count beside it. DLP now scans
// these as it scans a Messages request. Injection detection does not: nothing
// is generated from them.

/**
 * True for a provider's token-counting endpoint. Matched on the canonical
 * path, lowercased: a doubled slash, an escaped letter or a trailing slash
 * that the provider serves the same skipped DLP (#856). Erring towards a
 * match only scans a request the provider may reject.
 */
export function isTokenCountRequest(path: string): boolean {
  const p = canonicalPath(path).toLowerCase()
  return p === '/v1/messages/count_tokens' // Anthropic
    || p.endsWith('/responses/input_tokens') // OpenAI Responses
    || /\/models\/[^/]+:counttokens$/.test(p) // Gemini, Vertex AI
    || p === '/v1internal:counttokens' // Google Cloud Code (Antigravity, Gemini CLI)
}
