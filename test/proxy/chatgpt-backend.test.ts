import { describe, it, expect } from 'vitest'
import { isInterceptedHost, parserForRequest } from '../../src/proxy/proxy.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

// Codex CLI signed in with ChatGPT talks to chatgpt.com/backend-api/codex,
// which llm-fw never intercepted. Interception is per host, so covering it
// means intercepting the ChatGPT web app too: opt-in, and only the Codex
// paths are parsed.
const withSwitch = (on: boolean): Config => ({ ...DEFAULT_CONFIG, proxy: { ...DEFAULT_CONFIG.proxy, inspectChatgptBackend: on } })

describe('proxy.inspectChatgptBackend', () => {
  it('is off by default, and chatgpt.com is then tunnelled', () => {
    expect(DEFAULT_CONFIG.proxy.inspectChatgptBackend).toBe(false)
    expect(isInterceptedHost('chatgpt.com', DEFAULT_CONFIG)).toBe(false)
  })

  it('intercepts chatgpt.com only when switched on, and no other host because of it', () => {
    const on = withSwitch(true)
    expect(isInterceptedHost('chatgpt.com', on)).toBe(true)
    expect(isInterceptedHost('evil-chatgpt.com', on)).toBe(false)
    expect(isInterceptedHost('cdn.oaistatic.com', on)).toBe(false)
    expect(isInterceptedHost('api.openai.com', on)).toBe(true)
  })

  it('parses the Codex Responses path and nothing else on chatgpt.com', () => {
    const on = withSwitch(true)
    expect(parserForRequest('chatgpt.com', '/backend-api/codex/responses', on)).not.toBeNull()
    expect(parserForRequest('chatgpt.com', '/backend-api/conversation', on)).toBeNull()
    expect(parserForRequest('chatgpt.com', '/backend-api/f/responses', on)).toBeNull()
    expect(parserForRequest('api.openai.com', '/v1/responses', on)).not.toBeNull()
  })
})
