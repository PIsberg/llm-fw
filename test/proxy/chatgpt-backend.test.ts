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
  // On by default since 2026-10-31: on a machine running Codex with a ChatGPT
  // sign-in, every Codex turn was tunnelled uninspected (27 CONNECTs in one
  // afternoon) while the switch sat off. The ChatGPT web app is intercepted
  // too, as the configuration guide says; switch it off to tunnel it.
  it('is on by default, so chatgpt.com is intercepted; off tunnels it', () => {
    expect(DEFAULT_CONFIG.proxy.inspectChatgptBackend).toBe(true)
    expect(isInterceptedHost('chatgpt.com', DEFAULT_CONFIG)).toBe(true)
    expect(isInterceptedHost('chatgpt.com', withSwitch(false))).toBe(false)
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

  it('reads the Codex path however it is spelled, so a variant is not passed through unscanned', () => {
    const on = withSwitch(true)
    expect(parserForRequest('chatgpt.com', '/backend-api//codex/responses', on)).not.toBeNull()
    expect(parserForRequest('chatgpt.com', '/backend-api/%63odex/responses', on)).not.toBeNull()
    expect(parserForRequest('chatgpt.com', '/backend-api/x/../codex/responses', on)).not.toBeNull()
  })
})
