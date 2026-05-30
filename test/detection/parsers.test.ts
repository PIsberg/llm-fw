import { describe, it, expect } from 'vitest'
import { AnthropicParser, GeminiParser, getParser, parsers, extractPartialPrompts } from '../../src/detection/parsers.js'

const a = new AnthropicParser()
const g = new GeminiParser()

describe('AnthropicParser', () => {
  it('supports /v1/messages', () => {
    expect(a.supports('/v1/messages')).toBe(true)
  })

  it('does not support /v1/completions', () => {
    expect(a.supports('/v1/completions')).toBe(false)
  })

  it('extracts user message content', () => {
    const result = a.extractPrompts('{"messages":[{"role":"user","content":"hello"}]}')
    expect(result).toContain('hello')
  })

  it('skips assistant role messages', () => {
    const result = a.extractPrompts('{"messages":[{"role":"assistant","content":"reply"},{"role":"user","content":"q"}]}')
    expect(result).toEqual(['q'])
  })

  it('extracts text from array content blocks', () => {
    const result = a.extractPrompts('{"messages":[{"role":"user","content":[{"type":"text","text":"arr"}]}]}')
    expect(result).toContain('arr')
  })

  it('includes system field and user message', () => {
    const result = a.extractPrompts('{"system":"sys","messages":[{"role":"user","content":"hi"}]}')
    expect(result).toContain('sys')
    expect(result).toContain('hi')
  })

  it('returns [] for malformed JSON', () => {
    expect(a.extractPrompts('not json{')).toEqual([])
  })
})

describe('GeminiParser', () => {
  it('supports /v1beta/models/gemini-pro/generateContent', () => {
    expect(g.supports('/v1beta/models/gemini-pro/generateContent')).toBe(true)
  })

  it('does not support /v1/messages', () => {
    expect(g.supports('/v1/messages')).toBe(false)
  })

  it('extracts user content from contents array', () => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'gemini-user-text' }] }],
    })
    const result = g.extractPrompts(body)
    expect(result).toContain('gemini-user-text')
  })

  it('skips model role messages', () => {
    const body = JSON.stringify({
      contents: [
        { role: 'model', parts: [{ text: 'model-reply' }] },
        { role: 'user', parts: [{ text: 'user-turn' }] },
      ],
    })
    const result = g.extractPrompts(body)
    expect(result).not.toContain('model-reply')
    expect(result).toContain('user-turn')
  })

  it('extracts systemInstruction parts', () => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'be-helpful' }] },
    })
    const result = g.extractPrompts(body)
    expect(result).toContain('be-helpful')
  })
})

describe('getParser', () => {
  it('returns AnthropicParser for /v1/messages', () => {
    expect(getParser('/v1/messages')).toBeInstanceOf(AnthropicParser)
  })

  it('returns null for unknown path', () => {
    expect(getParser('/unknown')).toBeNull()
  })
})

describe('parsers', () => {
  it('has exactly 2 entries', () => {
    expect(parsers.length).toBe(2)
  })
})

describe('extractPartialPrompts', () => {
  it('extracts text from completed json string', () => {
    const result = extractPartialPrompts('{"system":"sys","messages":[{"role":"user","content":"hi"}]}')
    expect(result).toContain('sys')
    expect(result).toContain('hi')
  })

  it('extracts text from incomplete streaming prompt', () => {
    const partial = '{"messages":[{"role":"user","content":"Ignore all previous'
    const result = extractPartialPrompts(partial)
    expect(result).toContain('Ignore all previous')
  })

  it('extracts text from partially completed system prompt', () => {
    const partial = '{"system":"Be extremely restrict'
    const result = extractPartialPrompts(partial)
    expect(result).toContain('Be extremely restrict')
  })
})
