/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import { PayloadParser, MediaBlock } from '../types.js'
import { mediaBlockFromBase64, parseDataUrl } from './media.js'

/** Map a mime type onto the coarse MediaBlock kind. */
function kindFromMime(mime: string | undefined): MediaBlock['kind'] {
  const m = (mime ?? '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  return 'document'
}

/** MediaBlock from a (possibly data:) URL-bearing image/file part. */
function mediaBlockFromUrl(kind: MediaBlock['kind'], url: unknown): MediaBlock | null {
  if (typeof url !== 'string' || url.length === 0) return null
  const dataUrl = parseDataUrl(url)
  if (dataUrl) return mediaBlockFromBase64(kindFromMime(dataUrl.mimeType), dataUrl.mimeType, dataUrl.data)
  // Remote URL — nothing to decode locally; report as opaque.
  return { kind }
}

class AnthropicParser implements PayloadParser {
  supports(path: string): boolean {
    // Strip the query string before matching: real Anthropic traffic appends
    // `?beta=true` (and other flags), which would otherwise defeat an exact
    // equality check and leave the body uninspected.
    const p = (path.split('?')[0] ?? '')
    return p === '/v1/messages'
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

  extractMediaBlocks(body: string): MediaBlock[] {
    try {
      const data = JSON.parse(body)
      const out: MediaBlock[] = []

      const walkBlock = (block: any): void => {
        if (!block || typeof block !== 'object') return
        if (block.type === 'image' || block.type === 'document') {
          const kind: MediaBlock['kind'] = block.type === 'image' ? 'image' : 'document'
          const src = block.source
          if (!src || typeof src !== 'object') return
          if (src.type === 'base64' && typeof src.data === 'string') {
            out.push(mediaBlockFromBase64(kind, src.media_type, src.data))
          } else if (src.type === 'text' && typeof src.data === 'string') {
            out.push({ kind, mimeType: src.media_type ?? 'text/plain', text: src.data })
          } else if (src.type === 'content' && Array.isArray(src.content)) {
            // Custom-content documents: nested text blocks are directly scannable.
            const text = src.content
              .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
              .map((b: any) => b.text)
              .join('\n')
            out.push({ kind, ...(text ? { text } : {}) })
          } else {
            out.push({ kind }) // url or unknown source — opaque
          }
        } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
          // Tool results can return images/documents — the indirect vector.
          for (const inner of block.content) walkBlock(inner)
        }
      }

      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (Array.isArray(msg?.content)) for (const block of msg.content) walkBlock(block)
        }
      }
      return out
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

  extractMediaBlocks(body: string): MediaBlock[] {
    try {
      const data = JSON.parse(body)
      const out: MediaBlock[] = []

      const walkPart = (part: any): void => {
        if (!part || typeof part !== 'object') return
        // Chat vision: {type:'image_url', image_url:{url}} — url may be a
        // data: URL carrying the actual bytes. Responses: {type:'input_image',
        // image_url: string | {url}}.
        if (part.type === 'image_url' || part.type === 'input_image') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
          const block = mediaBlockFromUrl('image', url)
          if (block) out.push(block)
        } else if (part.type === 'input_file' || part.type === 'file') {
          // Responses input_file {file_data, filename} / Chat file {file:{file_data}}.
          const fileData = part.type === 'file' ? part.file?.file_data : part.file_data
          if (typeof fileData === 'string' && fileData.startsWith('data:')) {
            const block = mediaBlockFromUrl('file', fileData)
            if (block) out.push(block)
          } else if (typeof fileData === 'string' && fileData.length > 0) {
            // Raw base64 without a data: wrapper — sniff the content (PDF magic).
            out.push(mediaBlockFromBase64('file', undefined, fileData))
          } else {
            out.push({ kind: 'file' }) // file_id reference — opaque
          }
        } else if (part.type === 'input_audio') {
          const format = part.input_audio?.format
          out.push({ kind: 'audio', ...(typeof format === 'string' ? { mimeType: `audio/${format}` } : {}) })
        }
      }

      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (Array.isArray(msg?.content)) for (const part of msg.content) walkPart(part)
        }
      }
      if (Array.isArray(data.input)) {
        for (const item of data.input) {
          if (Array.isArray(item?.content)) for (const part of item.content) walkPart(part)
        }
      }
      return out
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

  extractMediaBlocks(body: string): MediaBlock[] {
    try {
      const data = JSON.parse(body)
      const out: MediaBlock[] = []
      // v2 messages use OpenAI-style image_url parts.
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (!Array.isArray(msg?.content)) continue
          for (const part of msg.content) {
            if (part && part.type === 'image_url') {
              const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
              const block = mediaBlockFromUrl('image', url)
              if (block) out.push(block)
            }
          }
        }
      }
      return out
    } catch { return [] }
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

  extractMediaBlocks(body: string): MediaBlock[] {
    try {
      const data = JSON.parse(body)
      const out: MediaBlock[] = []
      if (Array.isArray(data.contents)) {
        for (const content of data.contents) {
          if (!Array.isArray(content?.parts)) continue
          for (const part of content.parts) {
            // REST uses inlineData/fileData (camelCase); some SDKs emit snake_case.
            const inline = part?.inlineData ?? part?.inline_data
            const file = part?.fileData ?? part?.file_data
            if (inline && typeof inline === 'object' && typeof inline.data === 'string') {
              const mime = inline.mimeType ?? inline.mime_type
              out.push(mediaBlockFromBase64(kindFromMime(mime), mime, inline.data))
            } else if (file && typeof file === 'object') {
              const mime = file.mimeType ?? file.mime_type
              out.push({ kind: kindFromMime(mime), ...(typeof mime === 'string' ? { mimeType: mime } : {}) })
            }
          }
        }
      }
      return out
    } catch { return [] }
  }
}

/**
 * Parser for AWS Bedrock runtime endpoints:
 *   - Converse API: `/model/<id>/converse` and `/converse-stream` — the unified
 *     Bedrock format ({messages:[{role,content:[{text}]}], system:[{text}],
 *     toolConfig:{tools:[{toolSpec}]}}).
 *   - InvokeModel: `/model/<id>/invoke` and `/invoke-with-response-stream` —
 *     the body is the model's NATIVE format. Anthropic-native bodies (Claude on
 *     Bedrock) are delegated to AnthropicParser; Titan (`inputText`) and raw
 *     `prompt` bodies (Llama, Mistral) are handled inline.
 *
 * Converse content blocks are keyed by type ({text}, {image:{…}},
 * {toolUse:{…}}, {toolResult:{…}}) rather than carrying a `type` field, so the
 * Converse walks only consume untyped blocks — typed blocks belong to the
 * delegated Anthropic shape, which keeps the two passes duplicate-free.
 */
class BedrockParser implements PayloadParser {
  private anthropic = new AnthropicParser()

  supports(path: string): boolean {
    const p = (path.split('?')[0] ?? '')
    if (!p.startsWith('/model/')) return false
    return /\/(?:converse|converse-stream|invoke|invoke-with-response-stream)$/.test(p)
  }

  extractPrompts(body: string): string[] {
    const results = this.anthropic.extractPrompts(body)
    try {
      const data = JSON.parse(body)

      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
          for (const block of msg.content) {
            if (block && block.type === undefined && typeof block.text === 'string') {
              results.push(block.text)
            }
          }
        }
      }

      if (Array.isArray(data.system)) {
        for (const block of data.system) {
          if (block && block.type === undefined && typeof block.text === 'string') {
            results.push(block.text)
          }
        }
      }

      // InvokeModel native bodies: Titan uses `inputText`; Llama / Mistral
      // take a raw `prompt` string.
      if (typeof data.inputText === 'string') results.push(data.inputText)
      if (typeof data.prompt === 'string') results.push(data.prompt)

      return results.filter(s => s.length > 0)
    } catch {
      return results
    }
  }

  extractTools(body: string): any[] {
    try {
      const data = JSON.parse(body)
      const out: any[] = []
      // Converse: toolConfig.tools[].toolSpec — flatten so the MCP scanner
      // sees a top-level `name`, like every other provider.
      const tools = data.toolConfig?.tools
      if (Array.isArray(tools)) {
        for (const t of tools) {
          const spec = t?.toolSpec
          if (spec && typeof spec === 'object') out.push({ name: spec.name, ...spec })
        }
      }
      // InvokeModel Anthropic-native: flat tools[].
      if (Array.isArray(data.tools)) out.push(...data.tools)
      return out
    } catch { return [] }
  }

  extractToolResults(body: string): { toolUseId: string; result: string }[] {
    const results = this.anthropic.extractToolResults(body)
    try {
      const data = JSON.parse(body)
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
          for (const block of msg.content) {
            const tr = block?.toolResult
            if (tr && typeof tr === 'object') {
              results.push({
                toolUseId: typeof tr.toolUseId === 'string' ? tr.toolUseId : 'unknown',
                result: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? tr),
              })
            }
          }
        }
      }
      return results
    } catch {
      return results
    }
  }

  extractToolUses(body: string): { toolName: string; args: any }[] {
    const results = this.anthropic.extractToolUses(body)
    try {
      const data = JSON.parse(body)
      const blocks: any[] = []
      // Converse response: output.message.content[]; request echo of prior
      // assistant turns: messages[].content[].
      if (Array.isArray(data.output?.message?.content)) blocks.push(...data.output.message.content)
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role === 'assistant' && Array.isArray(msg.content)) blocks.push(...msg.content)
        }
      }
      for (const block of blocks) {
        const tu = block?.toolUse
        if (tu && typeof tu.name === 'string') {
          results.push({ toolName: tu.name, args: tu.input })
        }
      }
      return results
    } catch {
      return results
    }
  }

  extractMediaBlocks(body: string): MediaBlock[] {
    const out = this.anthropic.extractMediaBlocks(body)
    try {
      const data = JSON.parse(body)

      const walkBlock = (block: any): void => {
        if (!block || typeof block !== 'object') return
        for (const key of ['image', 'document', 'video'] as const) {
          const b = block[key]
          if (!b || typeof b !== 'object') continue
          const kind: MediaBlock['kind'] = key === 'document' ? 'document' : key
          const mime = typeof b.format === 'string'
            ? `${key === 'image' ? 'image' : key === 'video' ? 'video' : 'application'}/${b.format}`
            : undefined
          if (typeof b.source?.bytes === 'string') {
            out.push(mediaBlockFromBase64(kind, mime, b.source.bytes))
          } else if (typeof b.source?.text === 'string') {
            out.push({ kind, text: b.source.text, ...(mime ? { mimeType: mime } : {}) })
          } else {
            out.push({ kind, ...(mime ? { mimeType: mime } : {}) }) // s3Location etc. — opaque
          }
        }
        // Tool results can return media — the indirect vector.
        const trContent = block.toolResult?.content
        if (Array.isArray(trContent)) for (const inner of trContent) walkBlock(inner)
      }

      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (Array.isArray(msg?.content)) for (const block of msg.content) walkBlock(block)
        }
      }
      return out
    } catch {
      return out
    }
  }
}

export const parsers: PayloadParser[] = [
  new AnthropicParser(),
  new OpenAIParser(),
  new CohereParser(),
  new GeminiParser(),
  new BedrockParser(),
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

export { AnthropicParser, OpenAIParser, CohereParser, GeminiParser, BedrockParser }
