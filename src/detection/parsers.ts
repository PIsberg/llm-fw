import { PayloadParser } from '../types.js'

class AnthropicParser implements PayloadParser {
  supports(path: string): boolean {
    return path === '/v1/messages'
  }

  extractPrompts(body: string): string[] {
    try {
      const data = JSON.parse(body)
      const results: string[] = []

      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role !== 'user') continue
          if (typeof msg.content === 'string') {
            results.push(msg.content)
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                results.push(block.text)
              }
            }
          }
        }
      }

      if (typeof data.system === 'string') {
        results.push(data.system)
      }

      return results.filter(s => s.length > 0)
    } catch {
      return []
    }
  }
}

class GeminiParser implements PayloadParser {
  supports(path: string): boolean {
    return /^\/v1beta\/models\/.+\/generateContent/.test(path)
  }

  extractPrompts(body: string): string[] {
    try {
      const data = JSON.parse(body)
      const results: string[] = []

      if (Array.isArray(data.contents)) {
        for (const content of data.contents) {
          if (content.role === 'model') continue
          if (Array.isArray(content.parts)) {
            for (const part of content.parts) {
              if (typeof part.text === 'string') {
                results.push(part.text)
              }
            }
          }
        }
      }

      if (data.systemInstruction && Array.isArray(data.systemInstruction.parts)) {
        for (const part of data.systemInstruction.parts) {
          if (typeof part.text === 'string') {
            results.push(part.text)
          }
        }
      }

      return results.filter(s => s.length > 0)
    } catch {
      return []
    }
  }
}

export const parsers: PayloadParser[] = [new AnthropicParser(), new GeminiParser()]

export function getParser(path: string): PayloadParser | null {
  return parsers.find(p => p.supports(path)) ?? null
}

export { AnthropicParser, GeminiParser }
