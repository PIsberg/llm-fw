import { describe, it, expect } from 'vitest'
import { isTokenCountRequest } from '../../src/proxy/tokenCount.js'

// #856: GHSA-9986-fxc2-cx83 matched the token-counting paths as written, so a
// spelling the provider serves the same (a doubled slash, an escaped letter, a
// trailing slash) skipped DLP.
describe('isTokenCountRequest on paths a server would normalize (#856)', () => {
  it.each([
    '/v1/messages/count_tokens', '/v1//messages/count_tokens', '/v1/messages/%63ount_tokens',
    '/v1/messages/count_tokens/', '/v1/./messages/count_tokens?beta=true', '/V1/Messages/Count_Tokens',
    '/v1/responses/input_tokens', '/v1//responses/input_tokens/',
    '/v1beta/models/gemini-2.5-pro:countTokens', '/v1beta//models/gemini-2.5-pro:counttokens',
    '/v1internal:countTokens', '//v1internal:countTokens',
  ])('counts %s', (path) => {
    expect(isTokenCountRequest(path)).toBe(true)
  })

  it.each(['/v1/messages', '/v1/messages/count_tokens/x', '/v1internal:loadCodeAssist', '/v1/models'])('does not count %s', (path) => {
    expect(isTokenCountRequest(path)).toBe(false)
  })
})
