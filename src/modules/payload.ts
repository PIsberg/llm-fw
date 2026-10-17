// One walker over every provider request shape the modules rewrite, so each
// module states WHICH text it touches (by kind) instead of re-implementing
// where text lives in OpenAI chat, Anthropic, the Responses API and Gemini.

export type SlotKind = 'prompt' | 'system' | 'tool_result' | 'tool_definition'

export interface TextSlot {
  kind: SlotKind
  text: string
  /** The tool call a tool_result answers, when the format carries an id. */
  toolCallId?: string | undefined
  /** Writes `text` back into the payload in place. */
  set(text: string): void
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// Text part types across providers: Anthropic and chat `text`, Responses API
// `input_text` / `output_text`. Anything else (thinking, image, tool_use,
// document) is left alone; a thinking block's signature binds its bytes.
const TEXT_PARTS = new Set(['text', 'input_text', 'output_text'])

function fieldSlot(kind: SlotKind, holder: Obj, key: string, toolCallId?: string): TextSlot {
  return {
    kind,
    text: holder[key] as string,
    toolCallId,
    set(text) { holder[key] = text; this.text = text },
  }
}

function textParts(kind: SlotKind, parts: unknown[], out: TextSlot[], toolCallId?: string): void {
  for (const part of parts) {
    if (isObj(part) && typeof part.text === 'string' && (part.type === undefined || TEXT_PARTS.has(part.type as string))) {
      out.push(fieldSlot(kind, part, 'text', toolCallId))
    }
  }
}

// `content` of a message or of a tool_result block: a string or text parts.
function content(kind: SlotKind, holder: Obj, out: TextSlot[], toolCallId?: string): void {
  if (typeof holder.content === 'string') out.push(fieldSlot(kind, holder, 'content', toolCallId))
  else if (Array.isArray(holder.content)) textParts(kind, holder.content, out, toolCallId)
}

function roleKind(role: unknown): SlotKind {
  if (role === 'system' || role === 'developer') return 'system'
  if (role === 'tool') return 'tool_result'
  return 'prompt'
}

function message(m: unknown, out: TextSlot[]): void {
  if (!isObj(m)) return
  // Responses API tool output item.
  if (m.type === 'function_call_output') {
    if (typeof m.output === 'string') out.push(fieldSlot('tool_result', m, 'output', m.call_id as string | undefined))
    return
  }
  const kind = roleKind(m.role)
  const toolCallId = kind === 'tool_result' ? m.tool_call_id as string | undefined : undefined
  if (typeof m.content === 'string') {
    out.push(fieldSlot(kind, m, 'content', toolCallId))
    return
  }
  if (!Array.isArray(m.content)) return
  for (const part of m.content) {
    if (!isObj(part)) continue
    if (part.type === 'tool_result') {
      content('tool_result', part, out, part.tool_use_id as string | undefined)
    } else if (typeof part.text === 'string' && TEXT_PARTS.has(part.type as string)) {
      out.push(fieldSlot(kind, part, 'text', toolCallId))
    }
  }
}

// Every `description` string inside a JSON schema. A property NAMED
// "description" holds a schema object, not a string, so it is walked into
// rather than collected.
function schemaDescriptions(node: unknown, out: TextSlot[], depth = 0): void {
  if (depth > 32) return
  if (Array.isArray(node)) {
    for (const item of node) schemaDescriptions(item, out, depth + 1)
    return
  }
  if (!isObj(node)) return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') out.push(fieldSlot('tool_definition', node, key))
    else schemaDescriptions(value, out, depth + 1)
  }
}

function toolDefinition(tool: unknown, out: TextSlot[]): void {
  if (!isObj(tool)) return
  if (Array.isArray(tool.functionDeclarations)) {
    for (const decl of tool.functionDeclarations) toolDefinition(decl, out)
    return
  }
  const fn = isObj(tool.function) ? tool.function : tool
  if (typeof fn.description === 'string') out.push(fieldSlot('tool_definition', fn, 'description'))
  schemaDescriptions(fn.input_schema ?? fn.parameters, out)
}

/**
 * The text slots of a provider request, in the order the provider renders
 * them: tool definitions, then system text, then the conversation.
 */
export function collectTextSlots(payload: unknown): TextSlot[] {
  if (!isObj(payload)) return []
  const out: TextSlot[] = []

  if (Array.isArray(payload.tools)) for (const tool of payload.tools) toolDefinition(tool, out)

  if (typeof payload.system === 'string') out.push(fieldSlot('system', payload, 'system'))
  else if (Array.isArray(payload.system)) textParts('system', payload.system, out)
  if (typeof payload.instructions === 'string') out.push(fieldSlot('system', payload, 'instructions'))
  const si = payload.systemInstruction
  if (typeof si === 'string') out.push(fieldSlot('system', payload, 'systemInstruction'))
  else if (isObj(si) && Array.isArray(si.parts)) textParts('system', si.parts, out)

  if (Array.isArray(payload.messages)) for (const m of payload.messages) message(m, out)
  if (typeof payload.input === 'string') out.push(fieldSlot('prompt', payload, 'input'))
  else if (Array.isArray(payload.input)) for (const m of payload.input) message(m, out)
  if (Array.isArray(payload.contents)) {
    for (const item of payload.contents) {
      if (isObj(item) && Array.isArray(item.parts)) textParts('prompt', item.parts, out)
    }
  }
  if (typeof payload.prompt === 'string') out.push(fieldSlot('prompt', payload, 'prompt'))

  return out
}
