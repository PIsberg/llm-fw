/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
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

      // `system` can be a plain string or an array of content blocks
      // (the structured form used for prompt caching). Both must be inspected,
      // otherwise an injection wrapped in array form bypasses detection.
      if (typeof data.system === 'string') {
        results.push(data.system)
      } else if (Array.isArray(data.system)) {
        for (const block of data.system) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            results.push(block.text)
          }
        }
      }

      return results.filter(s => s.length > 0)
    } catch {
      return []
    }
  }

  extractTools(body: string): any[] {
    try {
      const data = JSON.parse(body)
      return Array.isArray(data.tools) ? data.tools : []
    } catch { return [] }
  }

  extractToolResults(body: string): { toolUseId: string; result: string }[] {
    try {
      const data = JSON.parse(body)
      const results: { toolUseId: string; result: string }[] = []
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'tool_result') {
                const resText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                // Anthropic tool_result blocks only carry the tool_use_id, not the tool name.
                results.push({ toolUseId: block.tool_use_id || 'unknown', result: resText })
              }
            }
          }
        }
      }
      return results
    } catch { return [] }
  }

  extractToolUses(body: string): { toolName: string; args: any }[] {
    try {
      const data = JSON.parse(body)
      const results: { toolName: string; args: any }[] = []
      let contentBlocks: any[] = []
      
      if (Array.isArray(data.content)) {
        contentBlocks = data.content // Response payload
      } else if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            contentBlocks.push(...msg.content)
          }
        }
      }

      for (const block of contentBlocks) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          results.push({ toolName: block.name, args: block.input })
        }
      }
      return results
    } catch { return [] }
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

  extractTools(body: string): any[] {
    try {
      const data = JSON.parse(body)
      return Array.isArray(data.tools) ? data.tools : []
    } catch { return [] }
  }

  extractToolResults(_body: string): { toolUseId: string; result: string }[] {
    return [] // Placeholder for Gemini
  }

  extractToolUses(body: string): { toolName: string; args: any }[] {
    try {
      const data = JSON.parse(body)
      const results: { toolName: string; args: any }[] = []
      if (Array.isArray(data.candidates)) {
        for (const cand of data.candidates) {
          if (cand.content && Array.isArray(cand.content.parts)) {
            for (const part of cand.content.parts) {
              if (part.functionCall && typeof part.functionCall.name === 'string') {
                results.push({ toolName: part.functionCall.name, args: part.functionCall.args })
              }
            }
          }
        }
      }
      return results
    } catch { return [] }
  }
}

export const parsers: PayloadParser[] = [new AnthropicParser(), new GeminiParser()]

export function getParser(path: string): PayloadParser | null {
  return parsers.find(p => p.supports(path)) ?? null
}

export function extractPartialPrompts(body: string): string[] {
  const results: string[] = []
  // Matches "text": "...", "content": "...", "system": "..." (handles escaped quotes and matches unclosed strings)
  const regex = /"(?:text|content|system)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)(?:"|$)/g
  let match
  while ((match = regex.exec(body)) !== null) {
    const val = match[1]
    if (val && val.length > 0) {
      const unescaped = val
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
      results.push(unescaped)
    }
  }

  // Also fallback to full structural parser if valid JSON is completed
  for (const parser of parsers) {
    try {
      const prompts = parser.extractPrompts(body)
      for (const p of prompts) {
        if (!results.includes(p)) {
          results.push(p)
        }
      }
    } catch {}
  }

  return results.filter(s => s.length > 0)
}

export { AnthropicParser, GeminiParser }
