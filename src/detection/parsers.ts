/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import { PayloadParser, MediaBlock, ConversationTurn, ToolResultItem } from '../types.js'
import { mediaBlockFromBase64, parseDataUrl } from './media.js'
import { canonicalPath } from './canonicalPath.js'

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

/**
 * The text of a tool result's content, as the model reads it. Array content
 * (what MCP tools return, and Converse's `toolResult.content`) is a list of
 * blocks: their text is joined one block per line, and a nested `content`
 * array is read the same way. A block with no text (a `json` payload, an
 * image by URL) keeps its JSON form; a base64 image is left to the media
 * stage (isBase64Image). Stringifying the whole array instead turned
 * every line break into the two characters `\n`, so a detector anchored on a
 * line start never saw one and an injection on its own line passed (#292).
 */
// The API's tool-name grammar, plus `.` and `:` some MCP clients use.
const TOOL_NAME = /^[\w.:-]{1,128}$/

// A screenshot an agent reads arrives as a base64 image block. Its JSON
// reached the text stages, and the classifier blocked 12 such tool results in
// a replay of real transcripts (2026-10-31). The media stage reads images
// (extractMediaBlocks walks tool results), so an image is not text here, but
// only one that is exactly an image: no other field, a media type the
// providers accept, base64 throughout, and bytes that open with that
// format's signature. Base64 text dressed as an image stays scanned.
const IMAGE_MEDIA = /^image\/(?:png|jpeg|gif|webp)$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
function isBase64Image(b: any): boolean {
  if (b?.type !== 'image' || Object.keys(b).length !== 2) return false
  const s = b.source
  if (s?.type !== 'base64' || typeof s.data !== 'string' || typeof s.media_type !== 'string') return false
  if (Object.keys(s).some(k => k !== 'type' && k !== 'media_type' && k !== 'data')) return false
  if (!IMAGE_MEDIA.test(s.media_type) || !BASE64.test(s.data)) return false
  const h = Buffer.from(s.data.slice(0, 24), 'base64')
  const png = h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47
  const jpeg = h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff
  const gif = h.subarray(0, 4).toString('latin1') === 'GIF8'
  const webp = h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP'
  return png || jpeg || gif || webp
}

/**
 * Whether `b` is exactly a Bedrock Converse image with its bytes inline: an
 * `image` key and nothing else, holding only one of Bedrock's four formats and
 * a `source` with base64 `bytes` that open as that format, as isBase64Image
 * checks. extractMediaBlocks reads it from tool results, so its bytes are not
 * text: as JSON they put megabytes of base64 through every text stage (#917).
 * Documents and videos keep their JSON: not every document format is one the
 * media path decodes, so their bytes stay where the text stages read them.
 */
function isBedrockInlineImage(b: any): boolean {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false
  if (Object.keys(b).length !== 1 || !b.image || typeof b.image !== 'object') return false
  const m = b.image
  if (Object.keys(m).some(k => k !== 'format' && k !== 'source') || !['png', 'jpeg', 'gif', 'webp'].includes(m.format)) return false
  const s = m.source
  if (!s || typeof s !== 'object' || Object.keys(s).length !== 1 || typeof s.bytes !== 'string') return false
  return isBase64Image({ type: 'image', source: { type: 'base64', media_type: `image/${m.format}`, data: s.bytes } })
}

/** Bedrock Converse reads its own image shape as media; every other provider scans that shape as text. */
function toolResultText(content: unknown, bedrock = false): string {
  if (typeof content === 'string') return content
  if (content === undefined) return ''
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content.map((b: any) => {
    if (typeof b === 'string') return b
    if (typeof b?.text === 'string') return b.text
    // A block's own title and context are text beside its content (#857).
    if (Array.isArray(b?.content)) return [b.title, b.context].filter((s: unknown): s is string => typeof s === 'string' && s.length > 0).concat(toolResultText(b.content, bedrock)).join('\n')
    // Images and files in a Responses tool output are read as media (#857).
    if (b?.type === 'input_image' || b?.type === 'input_file') return ''
    // Claude Code's tool search: a block that names a tool to load and holds
    // nothing else. Its JSON scored 98.8% injection on the classifier live.
    // One with any other field, or a name that is not a tool name, is scanned
    // whole, as an unknown block is.
    if (b?.type === 'tool_reference' && typeof b.tool_name === 'string' && TOOL_NAME.test(b.tool_name) && Object.keys(b).length === 2) return b.tool_name
    if (isBase64Image(b)) return ''
    if (bedrock && isBedrockInlineImage(b)) return ''
    return JSON.stringify(b)
  }).join('\n')
}

// Keys whose string values are text a model reads, in Anthropic's server-tool
// and search-result blocks. Everything else (ids, urls, media types, and
// encrypted_content, which llm-fw cannot read) is left out rather than
// stringified, so opaque base64 never reaches the entropy and decoding checks.
const THIRD_PARTY_TEXT_KEYS = new Set(['text', 'title', 'data', 'stdout', 'stderr', 'content'])

function extractRawTools(body: string): any[] {
  try {
    const data = JSON.parse(body)
    return Array.isArray(data.tools) ? data.tools : []
  } catch { return [] }
}

function extractNormalizedFunctionTools(body: string): any[] {
  try {
    const data = JSON.parse(body)
    if (!Array.isArray(data.tools)) return []
    return data.tools.map((t: any) => {
      const fn = t && typeof t === 'object' ? t.function : undefined
      if (fn && typeof fn === 'object') return { name: fn.name, ...fn }
      return t
    })
  } catch { return [] }
}

function pushWrappedFunctionCall(call: any, results: { toolName: string; args: any }[]): void {
  const fn = call?.function
  if (fn && typeof fn.name === 'string') {
    let parsedArgs: any = fn.arguments
    if (typeof fn.arguments === 'string') {
      try { parsedArgs = JSON.parse(fn.arguments) } catch { /* leave as raw string */ }
    }
    results.push({ toolName: fn.name, args: parsedArgs })
  }
}

/** The readable text inside a server-tool result or search result, in document order. */
function thirdPartyText(value: unknown, key = 'content'): string[] {
  if (typeof value === 'string') return THIRD_PARTY_TEXT_KEYS.has(key) ? [value] : []
  if (Array.isArray(value)) return value.flatMap(v => thirdPartyText(v, key))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => thirdPartyText(v, k))
  }
  return []
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

  extractSystem(body: string): string[] {
    try {
      const data = JSON.parse(body)
      const results: string[] = []
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
    } catch { return [] }
  }

  extractTools(body: string): any[] {
    return extractRawTools(body)
  }

  extractToolResults(body: string): ToolResultItem[] {
    try {
      const data = JSON.parse(body)
      const results: ToolResultItem[] = []
      if (Array.isArray(data.messages)) {
        // A tool_result block carries only the tool_use_id; the name and input
        // are on the assistant's tool_use block earlier in the history.
        const calls = new Map<string, { name: unknown; input: unknown }>()
        for (const msg of data.messages) {
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if ((block?.type === 'tool_use' || block?.type === 'server_tool_use' || block?.type === 'mcp_tool_use') && typeof block.id === 'string') {
                calls.set(block.id, { name: block.name, input: block.input })
              }
            }
          }
        }
        for (const msg of data.messages) {
          // Server tools (web fetch, web search, code execution, the MCP
          // connector) run at the provider; the client resends their results
          // in the assistant turn of every later request. A fetched page or an
          // MCP server's reply is third-party text like any tool_result.
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (typeof block?.type !== 'string' || !block.type.endsWith('_tool_result')) continue
              const call = calls.get(block.tool_use_id)
              results.push({
                toolUseId: block.tool_use_id || 'unknown',
                result: thirdPartyText(block.content).join('\n'),
                toolName: call && typeof call.name === 'string' ? call.name : block.type,
                ...(call ? { toolInput: call.input } : {}),
              })
            }
          }
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              // Retrieved text the client hands over as search results.
              if (block?.type === 'search_result') {
                results.push({ toolUseId: 'search_result', result: thirdPartyText([block.title, block.content]).join('\n'), toolName: 'search_result' })
                continue
              }
              if (block.type === 'tool_result') {
                const resText = toolResultText(block.content)
                const call = calls.get(block.tool_use_id)
                results.push({
                  toolUseId: block.tool_use_id || 'unknown',
                  result: resText,
                  ...(call && typeof call.name === 'string' ? { toolName: call.name, toolInput: call.input } : {}),
                })
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
        // Server tools (server_tool_use) and the MCP connector (mcp_tool_use)
        // invoke tools too, and a policy naming one must see them (#851).
        if ((block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') && typeof block.name === 'string') {
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

  extractConversation(body: string): ConversationTurn[] {
    try {
      const data = JSON.parse(body)
      const turns: ConversationTurn[] = []
      // The system prompt (string or content-block array) is the first turn.
      if (typeof data.system === 'string' && data.system) {
        turns.push({ role: 'system', text: data.system })
      } else if (Array.isArray(data.system)) {
        const t = data.system.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
        if (t) turns.push({ role: 'system', text: t })
      }
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          const role: ConversationTurn['role'] = msg.role === 'assistant' ? 'assistant' : 'user'
          let text = ''
          if (typeof msg.content === 'string') text = msg.content
          else if (Array.isArray(msg.content)) {
            text = msg.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
          }
          if (text) turns.push({ role, text })
        }
      }
      return turns
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

      // Legacy Completions (/v1/completions, which supports() has always
      // claimed): `prompt` is a string or a batch of strings, `suffix` the
      // text after an insertion point. Unread, every completions request
      // passed whatever it said (#857). A prompt of token ids holds no text
      // to scan.
      if (typeof data.prompt === 'string') {
        results.push(data.prompt)
      } else if (Array.isArray(data.prompt)) {
        for (const p of data.prompt) if (typeof p === 'string') results.push(p)
      } else if (data.prompt && typeof data.prompt === 'object') {
        // The Responses API's `prompt` names a stored template, and its
        // `variables` are text the server substitutes into it: a string, or
        // an input_text part. Unread before #857. Image and file variables
        // carry no text here.
        const variables = data.prompt.variables
        if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
          for (const v of Object.values(variables)) {
            if (typeof v === 'string') results.push(v)
            else if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'input_text' && typeof (v as { text?: unknown }).text === 'string') results.push((v as { text: string }).text)
          }
        }
      }
      if (typeof data.suffix === 'string') results.push(data.suffix)

      return results.filter(s => s.length > 0)
    } catch {
      return []
    }
  }

  extractSystem(body: string): string[] {
    try {
      const data = JSON.parse(body)
      const results: string[] = []
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role === 'system' || msg.role === 'developer') this.partsText(msg.content, results)
        }
      }
      if (Array.isArray(data.input)) {
        for (const item of data.input) {
          if (item && (item.role === 'system' || item.role === 'developer')) this.partsText(item.content, results)
        }
      }
      // Responses API top-level developer instructions.
      if (typeof data.instructions === 'string' && data.instructions.length > 0) {
        results.push(data.instructions)
      }
      return results.filter(s => s.length > 0)
    } catch { return [] }
  }

  extractTools(body: string): any[] {
    // Normalize {type:'function', function:{name,…}} (Chat) and the flat
    // Responses shape {type:'function', name,…} so the MCP scanner — which
    // reads `tool.name` — can enforce its blocklist uniformly.
    return extractNormalizedFunctionTools(body)
  }

  extractToolResults(body: string): ToolResultItem[] {
    try {
      const data = JSON.parse(body)
      const results: ToolResultItem[] = []
      // The call that produced each result, by id: assistant tool_calls in
      // chat, function_call items in the Responses API. Arguments stay the
      // JSON string the client sent.
      const calls = new Map<string, { toolName: string; toolInput: unknown }>()
      const withCall = (id: unknown) => {
        const call = typeof id === 'string' ? calls.get(id) : undefined
        return call ? { toolName: call.toolName, toolInput: call.toolInput } : {}
      }
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
          for (const tc of msg.tool_calls) {
            if (typeof tc?.id === 'string' && typeof tc.function?.name === 'string') calls.set(tc.id, { toolName: tc.function.name, toolInput: tc.function.arguments })
          }
        }
        for (const msg of data.messages) {
          if (msg.role === 'tool') {
            const resText = toolResultText(msg.content)
            results.push({ toolUseId: msg.tool_call_id || 'unknown', result: resText, ...withCall(msg.tool_call_id) })
          }
        }
      }
      // Responses API: tool output arrives as `*_call_output` input items
      // (function_call_output, custom_tool_call_output, local_shell_call_output),
      // never as a role:'tool' message, so Codex CLI's tool output was not
      // scanned at all. A non-text output (a computer_call_output screenshot
      // object) carries nothing to scan and is skipped.
      if (Array.isArray(data.input)) {
        for (const item of data.input) {
          if (item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
            calls.set(item.call_id, { toolName: item.name, toolInput: item.arguments })
          } else if (item?.type === 'local_shell_call' && typeof item.call_id === 'string' && item.action && typeof item.action === 'object') {
            // The built-in shell tool: its command and working directory sit in
            // `action`, flattened to the shape Codex's own shell tools send so
            // trusted paths (#437) read both the same way.
            calls.set(item.call_id, { toolName: 'local_shell_call', toolInput: { command: item.action.command, workdir: item.action.working_directory } })
          }
        }
        for (const item of data.input) {
          if (typeof item?.type !== 'string') continue
          // Hosted tools run at the provider and put their output on the call
          // item itself: an MCP server's reply, retrieved file text, sandbox
          // logs. Resent as input on later requests, they are third-party text.
          const hosted = item.type === 'mcp_call' ? (typeof item.output === 'string' ? [item.output] : [])
            : item.type === 'file_search_call' ? (Array.isArray(item.results) ? item.results.map((r: any) => r?.text) : [])
            : item.type === 'code_interpreter_call' ? (Array.isArray(item.outputs) ? item.outputs.map((o: any) => o?.logs) : [])
            : null
          if (hosted) {
            const text = hosted.filter((t: unknown): t is string => typeof t === 'string').join('\n')
            if (text) results.push({ toolUseId: item.id || 'unknown', result: text, toolName: typeof item.name === 'string' ? item.name : item.type })
            continue
          }
          if (!item.type.endsWith('_call_output')) continue
          if (typeof item.output !== 'string' && !Array.isArray(item.output)) continue
          results.push({ toolUseId: item.call_id || item.id || 'unknown', result: toolResultText(item.output), ...withCall(item.call_id) })
        }
      }
      return results
    } catch { return [] }
  }

  extractToolUses(body: string): { toolName: string; args: any }[] {
    try {
      const data = JSON.parse(body)
      const results: { toolName: string; args: any }[] = []
      const pushCall = (call: any) => pushWrappedFunctionCall(call, results)

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
      // Responses API: output[] items that call a tool (see responsesToolCall).
      if (Array.isArray(data.output)) {
        for (const item of data.output) {
          const call = responsesToolCall(item)
          if (call) results.push(call)
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
        // computer_call_output's screenshot is an image part by another name.
        if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'computer_screenshot') {
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
          const audio = part.input_audio?.data
          const mime = typeof format === 'string' ? `audio/${format}` : undefined
          // Keep the payload so opt-in transcription (#82) can read it.
          out.push(typeof audio === 'string' && audio.length > 0
            ? mediaBlockFromBase64('audio', mime, audio)
            : { kind: 'audio', ...(mime ? { mimeType: mime } : {}) })
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
          // A tool's output can hold images and files too (#857): a function
          // output's parts, and computer_call_output's screenshot object.
          if (typeof item?.type === 'string' && item.type.endsWith('_call_output')) {
            if (Array.isArray(item.output)) for (const part of item.output) walkPart(part)
            else if (item.output && typeof item.output === 'object') walkPart(item.output)
          }
        }
      }
      // A Responses prompt template's image and file variables are media
      // like any input part: decoded and scanned, or counted opaque (#857).
      const variables = data.prompt?.variables
      if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
        for (const v of Object.values(variables)) walkPart(v)
      }
      return out
    } catch { return [] }
  }

  extractConversation(body: string): ConversationTurn[] {
    try {
      const data = JSON.parse(body)
      const turns: ConversationTurn[] = []
      const roleOf = (r: unknown): ConversationTurn['role'] =>
        r === 'assistant' ? 'assistant' : (r === 'system' || r === 'developer') ? 'system' : 'user'
      const textOf = (content: unknown): string => {
        if (typeof content === 'string') return content
        if (Array.isArray(content)) return content.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join('\n')
        return ''
      }
      // Responses: top-level developer instructions come first (#857).
      if (typeof data.instructions === 'string' && data.instructions) turns.push({ role: 'system', text: data.instructions })
      // Chat Completions messages[] and Responses input[] both carry ordered turns.
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role === 'tool') continue
          const text = textOf(msg.content)
          if (text) turns.push({ role: roleOf(msg.role), text })
        }
      }
      // A Responses input given as one string is one user turn (#857).
      if (typeof data.input === 'string' && data.input) turns.push({ role: 'user', text: data.input })
      if (Array.isArray(data.input)) {
        for (const item of data.input) {
          if (!item || item.role === 'tool') continue
          const text = textOf(item.content)
          if (text) turns.push({ role: roleOf(item.role), text })
        }
      }
      return turns
    } catch { return [] }
  }
}

/**
 * Parser for Cohere's Chat API (`/v1/chat` and the OpenAI-like `/v2/chat`).
 * Covers prompt extraction and tool-definition enforcement; tool invocation
 * gating is left as a best-effort stub (Cohere streams tool calls in its own
 * event shape, handled by the generic passthrough).
 */
/** A Cohere v1 chat_history turn's role, lower-cased; '' when it has none. */
function cohereRole(turn: unknown): string {
  const role = (turn as Record<string, unknown> | null)?.role
  return typeof role === 'string' ? role.toLowerCase() : ''
}

class CohereParser implements PayloadParser {
  supports(path: string): boolean {
    const p = (path.split('?')[0] ?? '')
    return p.endsWith('/v1/chat') || p.endsWith('/v2/chat')
  }

  extractPrompts(body: string): string[] {
    try {
      const data = JSON.parse(body)
      const results: string[] = []

      // v1: { preamble, chat_history:[{role, message}], message }. `message` is
      // the newest user turn, so it goes last: the pipeline takes the last
      // prompt for the newest, and with `message` first it withheld an
      // injection there as an older turn instead of refusing it (#917). Every
      // history turn but the model's own is scanned, SYSTEM ones included: the
      // client sends them, and only the top-level preamble is the system
      // prompt. Roles in any case.
      if (typeof data.preamble === 'string') results.push(data.preamble)
      if (Array.isArray(data.chat_history)) {
        for (const turn of data.chat_history) {
          if (cohereRole(turn) !== 'chatbot' && typeof turn?.message === 'string') results.push(turn.message)
        }
      }
      if (typeof data.message === 'string') results.push(data.message)

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

  extractSystem(body: string): string[] {
    try {
      const data = JSON.parse(body)
      const results: string[] = []
      // v1 preamble.
      if (typeof data.preamble === 'string') results.push(data.preamble)
      // v2 system-role messages.
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (msg.role !== 'system') continue
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
    } catch { return [] }
  }

  extractTools(body: string): any[] {
    // v1 tools are flat {name,…}; v2 use {type:'function', function:{name,…}}.
    return extractNormalizedFunctionTools(body)
  }

  extractToolResults(body: string): ToolResultItem[] {
    try {
      const data = JSON.parse(body)
      const results: ToolResultItem[] = []

      // Grounding documents (both API versions): retrieved text the model is
      // told to answer from. v2 takes strings or {id, data:{...}}, v1 objects
      // of string fields such as title and snippet.
      if (Array.isArray(data.documents)) {
        for (const doc of data.documents) {
          const fields = typeof doc === 'string' ? [doc]
            : doc && typeof doc === 'object' ? Object.values((doc as { data?: unknown }).data ?? doc)
            : []
          const text = fields.filter((v): v is string => typeof v === 'string').join('\n')
          if (text) results.push({ toolUseId: typeof doc?.id === 'string' ? doc.id : 'document', result: text, toolName: 'documents' })
        }
      }

      // v1: tool_results:[{call:{name,…}, outputs:[…]}] — keyed by tool name
      // (v1 has no call id). The call travels with its result.
      if (Array.isArray(data.tool_results)) {
        for (const tr of data.tool_results) {
          if (!tr || typeof tr !== 'object') continue
          const name = tr.call?.name
          results.push({
            toolUseId: typeof name === 'string' ? name : 'unknown',
            result: toolResultText(tr.outputs ?? tr),
            ...(typeof name === 'string' ? { toolName: name, toolInput: tr.call.parameters } : {}),
          })
        }
      }

      // v2: OpenAI-like role:'tool' messages with tool_call_id + content,
      // paired with the assistant's tool_calls by id.
      if (Array.isArray(data.messages)) {
        const calls = new Map<string, { toolName: string; toolInput: unknown }>()
        for (const msg of data.messages) {
          if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
          for (const tc of msg.tool_calls) {
            if (typeof tc?.id === 'string' && typeof tc.function?.name === 'string') calls.set(tc.id, { toolName: tc.function.name, toolInput: tc.function.arguments })
          }
        }
        for (const msg of data.messages) {
          if (msg.role !== 'tool') continue
          const resText = toolResultText(msg.content)
          const call = typeof msg.tool_call_id === 'string' ? calls.get(msg.tool_call_id) : undefined
          results.push({ toolUseId: msg.tool_call_id || 'unknown', result: resText, ...call })
        }
      }

      return results
    } catch { return [] }
  }

  extractToolUses(body: string): { toolName: string; args: any }[] {
    try {
      const data = JSON.parse(body)
      const results: { toolName: string; args: any }[] = []

      // v1 response / request echo: tool_calls:[{name, parameters}] (flat).
      const pushFlat = (calls: unknown) => {
        if (!Array.isArray(calls)) return
        for (const call of calls) {
          if (call && typeof (call).name === 'string') {
            results.push({ toolName: (call).name, args: (call).parameters })
          } else {
            pushWrapped(call) // v2 shape can appear in the same slots
          }
        }
      }
      // v2: OpenAI-like {function:{name, arguments}} with stringified arguments.
      const pushWrapped = (call: any) => pushWrappedFunctionCall(call, results)

      pushFlat(data.tool_calls)                  // v1 response, v1 request echo
      pushFlat(data.message?.tool_calls)         // v2 response
      if (Array.isArray(data.messages)) {        // v2 request echoing assistant turns
        for (const msg of data.messages) {
          if (msg.role === 'assistant') pushFlat(msg.tool_calls)
        }
      }

      return results
    } catch { return [] }
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

  // The crescendo and multi-turn cipher stages read the whole conversation;
  // without this method both were off for this provider (#857).
  extractConversation(body: string): ConversationTurn[] {
    try {
      const data = JSON.parse(body)
      const turns: ConversationTurn[] = []
      const textOf = (c: unknown): string => typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((p: any) => typeof p?.text === 'string' && (p.type === undefined || p.type === 'text')).map((p: any) => p.text).join('\n') : ''
      // v2: OpenAI-like messages[], tool results under role 'tool'.
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          if (!msg || msg.role === 'tool') continue
          const text = textOf(msg.content)
          if (text) turns.push({ role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user', text })
        }
        return turns
      }
      // v1: preamble, chat_history[] with USER / CHATBOT / SYSTEM / TOOL roles, then the new message.
      if (typeof data.preamble === 'string' && data.preamble) turns.push({ role: 'system', text: data.preamble })
      if (Array.isArray(data.chat_history)) {
        for (const h of data.chat_history) {
          const role = String(h?.role ?? '').toUpperCase()
          if (role === 'TOOL' || typeof h?.message !== 'string' || !h.message) continue
          turns.push({ role: role === 'CHATBOT' ? 'assistant' : role === 'SYSTEM' ? 'system' : 'user', text: h.message })
        }
      }
      if (typeof data.message === 'string' && data.message) turns.push({ role: 'user', text: data.message })
      return turns
    } catch { return [] }
  }
}

/**
 * The text of a Gemini `functionResponse.response`. Gemini's convention is
 * `{ output }` for a result and `{ error }` for a failure, which Gemini CLI and
 * Antigravity follow; held as strings they are read as the text they are, one
 * per line. Read as JSON, every line break became the two characters `\n`, so
 * a rule anchored on a line start never saw one and a blocked output could not
 * be withheld (#594). Any other shape keeps its JSON form, so no field goes
 * unscanned.
 */
function geminiResponseText(response: unknown): string {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const entries = Object.entries(response)
    if (entries.length > 0 && entries.every(([k, v]) => (k === 'output' || k === 'error') && typeof v === 'string')) {
      return entries.map(([, v]) => v as string).join('\n')
    }
  }
  return toolResultText(response)
}

// Gemini's JSON mapping accepts each field in its proto name (snake_case) as
// well as lowerCamelCase, so a request can carry either spelling, or both of
// one field. Every detection input reads both, in that order, so the one the
// server picks is always among those scanned (#929).
function geminiFields(obj: unknown, camel: string, snake: string): unknown[] {
  if (!obj || typeof obj !== 'object') return []
  const o = obj as Record<string, unknown>
  const out: unknown[] = []
  if (o[camel] !== undefined && o[camel] !== null) out.push(o[camel])
  if (o[snake] !== undefined && o[snake] !== null) out.push(o[snake])
  return out
}
const geminiObjects = (obj: unknown, camel: string, snake: string): any[] => geminiFields(obj, camel, snake).filter(v => v && typeof v === 'object')
/** The text parts of a system instruction in either spelling (a bare string counts too). */
function geminiSystemTexts(data: unknown): string[] {
  const out: string[] = []
  for (const sys of geminiFields(data, 'systemInstruction', 'system_instruction')) {
    if (typeof sys === 'string') { out.push(sys); continue }
    const parts = (sys as { parts?: unknown }).parts
    if (Array.isArray(parts)) for (const part of parts) if (typeof part?.text === 'string') out.push(part.text)
  }
  return out
}
/** A blob's mime type; when its two spellings disagree, one the media stage reads as opaque. */
function geminiMime(blob: unknown): string | undefined {
  const types = geminiFields(blob, 'mimeType', 'mime_type').filter((t): t is string => typeof t === 'string')
  if (types.length === 0) return undefined
  return types.every(t => t === types[0]) ? types[0] : 'application/octet-stream'
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

      results.push(...geminiSystemTexts(data))

      return results.filter(s => s.length > 0)
    } catch {
      return []
    }
  }

  extractSystem(body: string): string[] {
    try {
      const data = JSON.parse(body)
      return geminiSystemTexts(data).filter(s => s.length > 0)
    } catch { return [] }
  }

  extractTools(body: string): any[] {
    return extractRawTools(body)
  }

  extractToolResults(body: string): ToolResultItem[] {
    try {
      const data = JSON.parse(body)
      const results: ToolResultItem[] = []
      if (Array.isArray(data.contents)) {
        // A functionResponse answers a functionCall in the nearest preceding
        // model turn: by id when both carry one, otherwise only when that turn
        // called the name once. Two same-named calls without ids leave the
        // pairing a guess, and a wrong guess would vouch for the other file.
        let calls: { id?: unknown; name: string; args: unknown }[] = []
        for (const content of data.contents) {
          if (!Array.isArray(content.parts)) continue
          if (content.role === 'model') {
            calls = content.parts
              .flatMap((part: any) => geminiObjects(part, 'functionCall', 'function_call'))
              .filter((fc: any) => typeof fc.name === 'string')
              .map((fc: any) => ({ id: fc.id, name: fc.name, args: fc.args }))
            // Code execution runs at the provider, and its output is resent in
            // the model turn: whatever the code read is third-party text.
            for (const part of content.parts) {
              for (const cer of geminiObjects(part, 'codeExecutionResult', 'code_execution_result')) {
                const output = cer.output
                if (typeof output === 'string' && output) results.push({ toolUseId: 'codeExecutionResult', result: output, toolName: 'codeExecution' })
              }
            }
            continue
          }
          for (const part of content.parts) {
            for (const fr of geminiObjects(part, 'functionResponse', 'function_response')) {
              const resText = geminiResponseText(fr.response ?? fr)
              const byId = typeof fr.id === 'string' ? calls.filter(c => c.id === fr.id) : []
              const byName = calls.filter(c => c.name === fr.name)
              const call = byId.length === 1 ? byId[0] : typeof fr.id !== 'string' && byName.length === 1 ? byName[0] : undefined
              results.push({
                toolUseId: typeof fr.name === 'string' ? fr.name : 'unknown',
                result: resText,
                ...(call ? { toolName: call.name, toolInput: call.args } : {}),
              })
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
              for (const fc of geminiObjects(part, 'functionCall', 'function_call')) {
                if (typeof fc.name === 'string') results.push({ toolName: fc.name, args: fc.args })
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
          // A functionResponse can carry media parts of its own (#857).
          const parts = content.parts.flatMap((part: any) => [
            part,
            ...geminiObjects(part, 'functionResponse', 'function_response').flatMap((fr: any) => Array.isArray(fr.parts) ? fr.parts : []),
          ])
          for (const part of parts) {
            // REST uses inlineData/fileData (camelCase); some SDKs emit
            // snake_case, and a part can carry both (#929): each is read.
            for (const inline of geminiObjects(part, 'inlineData', 'inline_data')) {
              if (typeof inline.data !== 'string') continue
              const mime = geminiMime(inline)
              out.push(mediaBlockFromBase64(kindFromMime(mime), mime, inline.data))
            }
            for (const file of geminiObjects(part, 'fileData', 'file_data')) {
              const mime = geminiMime(file)
              out.push({ kind: kindFromMime(mime), ...(typeof mime === 'string' ? { mimeType: mime } : {}) })
            }
          }
        }
      }
      return out
    } catch { return [] }
  }

  // The crescendo and multi-turn cipher stages read the whole conversation;
  // without this method both were off for this provider (#857).
  extractConversation(body: string): ConversationTurn[] {
    try {
      const data = JSON.parse(body)
      const turns: ConversationTurn[] = []
      // Text parts only: a functionCall or functionResponse turn is a tool
      // exchange, and a thought part is the model's own reasoning.
      const textOf = (parts: unknown): string => Array.isArray(parts)
        ? parts.filter((p: any) => typeof p?.text === 'string' && p.thought !== true).map((p: any) => p.text).join('\n') : ''
      const system = geminiFields(data, 'systemInstruction', 'system_instruction')
        .map((sys: any) => typeof sys === 'string' ? sys : textOf(sys?.parts)).filter(Boolean).join('\n')
      if (system) turns.push({ role: 'system', text: system })
      if (Array.isArray(data.contents)) {
        for (const content of data.contents) {
          const text = textOf(content?.parts)
          if (text) turns.push({ role: content.role === 'model' ? 'assistant' : 'user', text })
        }
      }
      return turns
    } catch { return [] }
  }
}

/**
 * The Gemini body inside a Google Cloud Code envelope, serialised again: the
 * object under `key` when there is one, otherwise the body itself, so a client
 * that sends a bare Gemini body is still read.
 */
function cloudCodeInner(body: string, key: 'request' | 'response'): string {
  try {
    const inner = JSON.parse(body)?.[key]
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? JSON.stringify(inner) : body
  } catch { return body }
}

/**
 * Google's Cloud Code API (`cloudcode-pa.googleapis.com`, and the
 * `daily-cloudcode-pa` host Antigravity calls), the backend of Antigravity,
 * Gemini CLI and Gemini Code Assist (#594). `/v1internal:generateContent` and
 * `:streamGenerateContent` take a Gemini request wrapped as
 * `{ model, project, request: { contents, systemInstruction, tools } }`, and
 * answer with Gemini responses wrapped as `{ response: { candidates }, traceId }`,
 * one per SSE event when streamed. Every extractor reads the Gemini body inside.
 * The account, quota and telemetry methods on the same host carry no
 * conversation and are not matched.
 */
class CloudCodeParser extends GeminiParser {
  override supports(path: string): boolean {
    const p = path.split('?')[0] ?? ''
    return p === '/v1internal:generateContent' || p === '/v1internal:streamGenerateContent'
  }

  override extractPrompts(body: string): string[] { return super.extractPrompts(cloudCodeInner(body, 'request')) }
  override extractSystem(body: string): string[] { return super.extractSystem(cloudCodeInner(body, 'request')) }
  override extractTools(body: string): any[] { return super.extractTools(cloudCodeInner(body, 'request')) }
  override extractToolResults(body: string): ToolResultItem[] { return super.extractToolResults(cloudCodeInner(body, 'request')) }
  override extractMediaBlocks(body: string): MediaBlock[] { return super.extractMediaBlocks(cloudCodeInner(body, 'request')) }
  override extractToolUses(body: string): { toolName: string; args: any }[] { return super.extractToolUses(cloudCodeInner(body, 'response')) }
  override extractConversation(body: string): ConversationTurn[] { return super.extractConversation(cloudCodeInner(body, 'request')) }
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

  extractSystem(body: string): string[] {
    // Native InvokeModel Anthropic bodies carry `system` in the Anthropic shape.
    const results = this.anthropic.extractSystem(body)
    try {
      const data = JSON.parse(body)
      // Converse format: system: [{ text }] (no `type` discriminator).
      if (Array.isArray(data.system)) {
        for (const block of data.system) {
          if (block && block.type === undefined && typeof block.text === 'string') {
            results.push(block.text)
          }
        }
      }
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

  extractToolResults(body: string): ToolResultItem[] {
    const results = this.anthropic.extractToolResults(body)
    try {
      const data = JSON.parse(body)
      if (Array.isArray(data.messages)) {
        // Converse toolResult blocks carry only the toolUseId; the name and
        // input are on the assistant's toolUse block.
        const calls = new Map<string, { toolName: string; toolInput: unknown }>()
        for (const msg of data.messages) {
          if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
          for (const block of msg.content) {
            const tu = block?.toolUse
            if (typeof tu?.toolUseId === 'string' && typeof tu.name === 'string') calls.set(tu.toolUseId, { toolName: tu.name, toolInput: tu.input })
          }
        }
        for (const msg of data.messages) {
          if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
          for (const block of msg.content) {
            const tr = block?.toolResult
            if (tr && typeof tr === 'object') {
              const call = typeof tr.toolUseId === 'string' ? calls.get(tr.toolUseId) : undefined
              results.push({
                toolUseId: typeof tr.toolUseId === 'string' ? tr.toolUseId : 'unknown',
                result: toolResultText(tr.content ?? tr, true),
                ...call,
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

  // The crescendo and multi-turn cipher stages read the whole conversation;
  // without this method both were off for this provider (#857).
  extractConversation(body: string): ConversationTurn[] {
    try {
      const data = JSON.parse(body)
      const turns: ConversationTurn[] = []
      // Converse blocks are {text}; Anthropic-native InvokeModel blocks are
      // {type: 'text', text}. Tool use and results are left out of both.
      const textOf = (c: unknown): string => typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((b: any) => typeof b?.text === 'string' && (b.type === undefined || b.type === 'text')).map((b: any) => b.text).join('\n') : ''
      const system = textOf(data.system)
      if (system) turns.push({ role: 'system', text: system })
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          const text = textOf(msg?.content)
          if (text) turns.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', text })
        }
      }
      return turns
    } catch { return [] }
  }
}

export const parsers: PayloadParser[] = [
  new AnthropicParser(),
  new OpenAIParser(),
  new CohereParser(),
  new GeminiParser(),
  new CloudCodeParser(),
  new BedrockParser(),
]

/**
 * The parser for a request path, matched on the path as sent and then on its
 * canonical form (see canonicalPath). Without the second step a body sent to
 * `/v1//messages` was forwarded with only an "unrecognized endpoint" warning.
 * Erring towards a match is safe: scanning a request the provider would have
 * rejected costs nothing.
 */
/**
 * The tool call an OpenAI Responses API output item makes, or null when it
 * makes none. `function_call` carries JSON `arguments`; `custom_tool_call`
 * (Codex's code-mode `exec`, `apply_patch`) carries free-text `input`;
 * `local_shell_call` carries its command in `action`.
 */
/** The Responses API events that carry a call's arguments as they stream (#916: and a hosted MCP call's). */
export const RESPONSES_ARGUMENT_DELTAS: ReadonlySet<string> = new Set(['response.function_call_arguments.delta', 'response.custom_tool_call_input.delta', 'response.mcp_call_arguments.delta'])

export function responsesToolCall(item: unknown): { toolName: string; args: any } | null {
  if (!item || typeof item !== 'object') return null
  const it = item as Record<string, unknown>
  if (it.type === 'function_call' && typeof it.name === 'string') {
    let args: any = it.arguments
    if (typeof it.arguments === 'string') {
      try { args = JSON.parse(it.arguments) } catch { /* raw */ }
    }
    return { toolName: it.name, args }
  }
  if (it.type === 'custom_tool_call' && typeof it.name === 'string') return { toolName: it.name, args: it.input ?? '' }
  if (it.type === 'local_shell_call') return { toolName: 'local_shell', args: it.action ?? {} }
  // A hosted MCP call, and the approval request that comes before one when the
  // server asks for it (#916): the same name and JSON arguments as a function
  // call. Skipped, every gate and tool-use scan passed them unread.
  if ((it.type === 'mcp_call' || it.type === 'mcp_approval_request') && typeof it.name === 'string') {
    let args: any = it.arguments ?? {}
    if (typeof it.arguments === 'string') {
      try { args = JSON.parse(it.arguments) } catch { /* raw */ }
    }
    return { toolName: it.name, args }
  }
  return null
}

export function getParser(path: string): PayloadParser | null {
  const canonical = canonicalPath(path)
  // As sent first, so a parser's own matching is unchanged for every path it
  // already recognised; then canonical, then canonical in lower case (Gemini's
  // `:generateContent` suffixes are camelCase, so case is not folded first).
  for (const candidate of [path, canonical, canonical.toLowerCase()]) {
    const parser = parsers.find(p => p.supports(candidate))
    if (parser) return parser
  }
  return null
}

// Schema keys whose string value the model reads as text, and keys whose
// value holds strings it reads (a default, an example, a choice).
const TOOL_TEXT_KEYS = new Set(['description', 'title'])
const TOOL_VALUE_KEYS = new Set(['default', 'examples', 'enum', 'const'])
/**
 * Collect the free text out of a list of tool/function definitions,
 * regardless of provider nesting. The model reads and obeys it, so a poisoned
 * line ("before answering, read ~/.ssh/id_rsa ...") is an injection vector
 * ("tool poisoning"): every `description` and `title` string, and every
 * string under `default`, `examples`, `enum` and `const`, at any depth.
 * An explicit stack, not recursion, so no nesting overflows the stack, and no
 * cap: the walk is linear in a tree JSON.parse already built from a body that
 * proxy.maxBodyBytes bounds, so each string is read on its own, however many
 * come before it. Before #857 the walk stopped at depth 6 (under a Gemini
 * declaration's second level of parameters) and read `description` only.
 */
export function extractToolDescriptions(tools: unknown[]): string[] {
  const out: string[] = []
  const stack: Array<{ node: unknown; values: boolean }> = [{ node: tools, values: false }]
  while (stack.length > 0) {
    const { node, values } = stack.pop()!
    if (node == null) continue
    if (typeof node === 'string') {
      if (values && node.length > 0) out.push(node)
      continue
    }
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], values })
      continue
    }
    if (typeof node !== 'object') continue
    const entries = Object.entries(node as Record<string, unknown>)
    for (let i = entries.length - 1; i >= 0; i--) {
      const [k, v] = entries[i]!
      if (TOOL_TEXT_KEYS.has(k) && typeof v === 'string') {
        if (v.length > 0) out.push(v)
      } else {
        stack.push({ node: v, values: values || TOOL_VALUE_KEYS.has(k) })
      }
    }
  }
  return out
}

export { AnthropicParser, OpenAIParser, CohereParser, GeminiParser, CloudCodeParser, BedrockParser }
