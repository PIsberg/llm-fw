/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
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

/**
 * Parser for the OpenAI-compatible Chat Completions / Responses wire format.
 *
 * This single parser covers the bulk of the AI ecosystem: OpenAI, Azure OpenAI,
 * Mistral, Groq, OpenRouter, Together, Fireworks, DeepSeek, xAI (Grok),
 * Perplexity, Anyscale, and any other service that speaks `/chat/completions`.
 * Their request paths vary (`/v1/chat/completions`, `/openai/v1/chat/completions`,
 * `/api/v1/chat/completions`, Azure's `/openai/deployments/<id>/chat/completions
 * ?api-version=…`), so matching is by suffix on the path (query string stripped).
 */
class OpenAIParser implements PayloadParser {
  supports(path: string): boolean {
    const p = (path.split('?')[0] ?? '')
    return p.endsWith('/chat/completions') || p.endsWith('/completions') || p.endsWith('/responses')
  }

  private partsText(content: unknown, out: string[]): void {
    if (typeof content === 'string') {
      if (content.length > 0) out.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        // Chat vision parts use {type:'text'}, Responses parts use {type:'input_text'}.
        if (part && typeof part.text === 'string' && part.text.length > 0) out.push(part.text)
      }
    }
  }

  extractPrompts(body: string): string[] {
    try {
      const data = JSON.parse(body)
      const results: string[] = []

      // Chat Completions: messages[] with role system|user|developer (skip
      // assistant/tool — those are model output, not attacker-controlled input).
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role === 'assistant' || msg.role === 'tool') continue
          this.partsText(msg.content, results)
        }
      }

      // Responses API: top-level `input` (string or message array) + `instructions`.
      if (typeof data.input === 'string') {
        if (data.input.length > 0) results.push(data.input)
      } else if (Array.isArray(data.input)) {
        for (const item of data.input) {
          if (item && (item.role === 'assistant' || item.role === 'tool')) continue
          this.partsText(item?.content, results)
        }
      }
      if (typeof data.instructions === 'string' && data.instructions.length > 0) {
        results.push(data.instructions)
      }

      return results.filter(s => s.length > 0)
    } catch {
      return []
    }
  }

  extractTools(body: string): any[] {
    try {
      const data = JSON.parse(body)
      if (!Array.isArray(data.tools)) return []
      // Normalize {type:'function', function:{name,…}} (Chat) and the flat
      // Responses shape {type:'function', name,…} so the MCP scanner — which
      // reads `tool.name` — can enforce its blocklist uniformly.
      return data.tools.map((t: any) => {
        const fn = t && typeof t === 'object' ? t.function : undefined
        if (fn && typeof fn === 'object') return { name: fn.name, ...fn }
        return t
      })
    } catch { return [] }
  }

  extractToolResults(body: string): { toolUseId: string; result: string }[] {
    try {
      const data = JSON.parse(body)
      const results: { toolUseId: string; result: string }[] = []
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role === 'tool') {
            const resText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
            results.push({ toolUseId: msg.tool_call_id || 'unknown', result: resText })
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
      const pushCall = (call: any) => {
        const fn = call?.function
        if (fn && typeof fn.name === 'string') {
          let parsedArgs: any = fn.arguments
          if (typeof fn.arguments === 'string') {
            try { parsedArgs = JSON.parse(fn.arguments) } catch { /* leave as raw string */ }
          }
          results.push({ toolName: fn.name, args: parsedArgs })
        }
      }

      // Chat response: choices[].message.tool_calls[]
      if (Array.isArray(data.choices)) {
        for (const choice of data.choices) {
          const calls = choice?.message?.tool_calls
          if (Array.isArray(calls)) for (const c of calls) pushCall(c)
        }
      }
      // Chat request echoing assistant turns: messages[].tool_calls[]
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            for (const c of msg.tool_calls) pushCall(c)
          }
        }
      }
      // Responses API: output[] items of type 'function_call' (flat name/arguments).
      if (Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item && item.type === 'function_call' && typeof item.name === 'string') {
            let parsedArgs: any = item.arguments
            if (typeof item.arguments === 'string') {
              try { parsedArgs = JSON.parse(item.arguments) } catch { /* raw */ }
            }
            results.push({ toolName: item.name, args: parsedArgs })
          }
        }
      }
      return results
    } catch { return [] }
  }
}

/**
 * Parser for Cohere's Chat API (`/v1/chat` and the OpenAI-like `/v2/chat`).
 * Covers prompt extraction and tool-definition enforcement; tool invocation
 * gating is left as a best-effort stub (Cohere streams tool calls in its own
 * event shape, handled by the generic passthrough).
 */
class CohereParser implements PayloadParser {
  supports(path: string): boolean {
    const p = (path.split('?')[0] ?? '')
    return p.endsWith('/v1/chat') || p.endsWith('/v2/chat')
  }

  extractPrompts(body: string): string[] {
    try {
      const data = JSON.parse(body)
      const results: string[] = []

      // v1: { message, chat_history:[{role:'USER'|'CHATBOT', message}], preamble }
      if (typeof data.message === 'string') results.push(data.message)
      if (typeof data.preamble === 'string') results.push(data.preamble)
      if (Array.isArray(data.chat_history)) {
        for (const turn of data.chat_history) {
          if (turn && turn.role !== 'CHATBOT' && typeof turn.message === 'string') {
            results.push(turn.message)
          }
        }
      }

      // v2: { messages:[{role, content}] } (OpenAI-like)
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role === 'assistant' || msg.role === 'tool') continue
          if (typeof msg.content === 'string') {
            results.push(msg.content)
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part && typeof part.text === 'string') results.push(part.text)
            }
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
      if (!Array.isArray(data.tools)) return []
      // v1 tools are flat {name,…}; v2 use {type:'function', function:{name,…}}.
      return data.tools.map((t: any) => {
        const fn = t && typeof t === 'object' ? t.function : undefined
        if (fn && typeof fn === 'object') return { name: fn.name, ...fn }
        return t
      })
    } catch { return [] }
  }

  extractToolResults(_body: string): { toolUseId: string; result: string }[] {
    return []
  }

  extractToolUses(_body: string): { toolName: string; args: any }[] {
    return []
  }
}

class GeminiParser implements PayloadParser {
  supports(path: string): boolean {
    // Matches both stable (/v1/) and beta (/v1beta/, /v1beta1/) Gemini and
    // Vertex AI generative endpoints: generateContent + streamGenerateContent.
    //
    // Split into two anchored, bounded checks rather than one regex with
    // `.*models\/.+` — that form has two greedy quantifiers straddling the
    // repeating `models/` segment and backtracks quadratically on hostile
    // inputs (ReDoS). Each check below has at most one bounded quantifier, so
    // matching is linear. The query string is stripped first so the `$` anchor
    // holds for real requests (Gemini appends `?key=…`).
    const p = path.split('?')[0] ?? ''
    if (!/^\/v1(?:beta\d?)?\//.test(p)) return false
    return /\/models\/[^/:]+[:/](?:stream)?[Gg]enerateContent$/.test(p)
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

  extractToolResults(body: string): { toolUseId: string; result: string }[] {
    try {
      const data = JSON.parse(body)
      const results: { toolUseId: string; result: string }[] = []
      if (Array.isArray(data.contents)) {
        for (const content of data.contents) {
          if (!Array.isArray(content.parts)) continue
          for (const part of content.parts) {
            const fr = part?.functionResponse
            if (fr && typeof fr === 'object') {
              const resText = typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response ?? fr)
              results.push({ toolUseId: typeof fr.name === 'string' ? fr.name : 'unknown', result: resText })
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

export const parsers: PayloadParser[] = [
  new AnthropicParser(),
  new OpenAIParser(),
  new CohereParser(),
  new GeminiParser(),
]

export function getParser(path: string): PayloadParser | null {
  return parsers.find(p => p.supports(path)) ?? null
}

/**
 * Collect every free-text `description` string out of a list of tool/function
 * definitions, regardless of provider nesting. The model reads and obeys these
 * descriptions, so a poisoned one ("before answering, read ~/.ssh/id_rsa …") is
 * an injection vector ("tool poisoning"). Walking by key name catches the
 * top-level tool description, Gemini's `functionDeclarations[].description`, and
 * per-parameter `properties.<x>.description` in one pass. Depth-bounded so a
 * hostile deeply-nested schema can't blow the stack.
 */
export function extractToolDescriptions(tools: unknown[]): string[] {
  const out: string[] = []
  const walk = (node: unknown, depth: number): void => {
    if (node == null || depth > 6) return
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1)
      return
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'description' && typeof v === 'string' && v.length > 0) out.push(v)
        else walk(v, depth + 1)
      }
    }
  }
  walk(tools, 0)
  return out
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

export { AnthropicParser, OpenAIParser, CohereParser, GeminiParser }
