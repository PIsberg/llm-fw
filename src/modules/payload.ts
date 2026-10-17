// One walker over every provider request shape the modules rewrite, so each
// module states WHICH text it touches (by kind) instead of re-implementing
// where text lives in OpenAI chat, Anthropic, the Responses API and Gemini.

export type SlotKind = 'prompt' | 'system' | 'tool_result' | 'tool_definition'

export interface TextSlot {
  kind: SlotKind
  text: string
  /** The tool call a tool_result answers, when the format carries an id. */
  toolCallId?: string | undefined
  /**
   * The tool that call named, when the call is in the same request. A request
   * continuing a server-side thread carries results without their calls.
   */
  toolName?: string | undefined
  /** Writes `text` back into the payload in place. */
  set(text: string): void
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// Text part types across providers: Anthropic and chat `text`, Responses API
// `input_text` / `output_text`. Anything else (thinking, image, tool_use,
// document) is left alone; a thinking block's signature binds its bytes.
const TEXT_PARTS = new Set(['text', 'input_text', 'output_text'])

type ToolRef = Pick<TextSlot, 'toolCallId' | 'toolName'>

// Tool call id to tool name, for the calls seen so far in one request.
type Calls = Map<string, string>

const ref = (id: unknown, calls: Calls): ToolRef =>
  typeof id === 'string' ? { toolCallId: id, toolName: calls.get(id) } : {}

function fieldSlot(kind: SlotKind, holder: Obj, key: string, tool: ToolRef = {}): TextSlot {
  return {
    kind,
    text: holder[key] as string,
    ...tool,
    set(text) { holder[key] = text; this.text = text },
  }
}

function textParts(kind: SlotKind, parts: unknown[], out: TextSlot[], tool?: ToolRef): void {
  for (const part of parts) {
    if (isObj(part) && typeof part.text === 'string' && (part.type === undefined || TEXT_PARTS.has(part.type as string))) {
      out.push(fieldSlot(kind, part, 'text', tool))
    }
  }
}

// `content` of a message or of a tool_result block: a string or text parts.
function content(kind: SlotKind, holder: Obj, out: TextSlot[], tool?: ToolRef): void {
  if (typeof holder.content === 'string') out.push(fieldSlot(kind, holder, 'content', tool))
  else if (Array.isArray(holder.content)) textParts(kind, holder.content, out, tool)
}

function roleKind(role: unknown): SlotKind {
  if (role === 'system' || role === 'developer') return 'system'
  if (role === 'tool') return 'tool_result'
  return 'prompt'
}

// OpenAI chat: the calls an assistant message makes.
function chatCalls(toolCalls: unknown[], calls: Calls): void {
  for (const call of toolCalls) {
    if (isObj(call) && typeof call.id === 'string' && isObj(call.function) && typeof call.function.name === 'string') {
      calls.set(call.id, call.function.name)
    }
  }
}

function message(m: unknown, out: TextSlot[], calls: Calls): void {
  if (!isObj(m)) return
  // Responses API tool call and tool output items.
  if (m.type === 'function_call') {
    if (typeof m.call_id === 'string' && typeof m.name === 'string') calls.set(m.call_id, m.name)
    return
  }
  if (m.type === 'function_call_output') {
    if (typeof m.output === 'string') out.push(fieldSlot('tool_result', m, 'output', ref(m.call_id, calls)))
    return
  }
  if (Array.isArray(m.tool_calls)) chatCalls(m.tool_calls, calls)
  const kind = roleKind(m.role)
  const tool = kind === 'tool_result' ? ref(m.tool_call_id, calls) : {}
  if (typeof m.content === 'string') {
    out.push(fieldSlot(kind, m, 'content', tool))
    return
  }
  if (!Array.isArray(m.content)) return
  for (const part of m.content) {
    if (!isObj(part)) continue
    if (part.type === 'tool_use') {
      if (typeof part.id === 'string' && typeof part.name === 'string') calls.set(part.id, part.name)
    } else if (part.type === 'tool_result') {
      content('tool_result', part, out, ref(part.tool_use_id, calls))
    } else if (part.type === 'tool_addition') {
      // A tool added mid-conversation (Claude Code on a server-side thread).
      toolDefinition(part.tool, out)
    } else if (typeof part.text === 'string' && TEXT_PARTS.has(part.type as string)) {
      out.push(fieldSlot(kind, part, 'text', tool))
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

  const calls: Calls = new Map()
  if (Array.isArray(payload.messages)) for (const m of payload.messages) message(m, out, calls)
  if (typeof payload.input === 'string') out.push(fieldSlot('prompt', payload, 'input'))
  else if (Array.isArray(payload.input)) for (const m of payload.input) message(m, out, calls)
  if (Array.isArray(payload.contents)) {
    for (const item of payload.contents) {
      if (isObj(item) && Array.isArray(item.parts)) textParts('prompt', item.parts, out)
    }
  }
  if (typeof payload.prompt === 'string') out.push(fieldSlot('prompt', payload, 'prompt'))

  return out
}
