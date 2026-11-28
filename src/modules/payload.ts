// One walker over every provider request shape the modules rewrite, so each

/**
 * A Gemini field in either JSON spelling: the camelCase name or the proto's
 * snake_case one, which Gemini's JSON mapping accepts too (#946). The camelCase
 * value wins when both are set.
 */
export function geminiField(obj: unknown, camel: string, snake: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  const o = obj as Record<string, unknown>
  return o[camel] ?? o[snake]
}
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
  /**
   * That call's arguments as the request carries them: an object for
   * Anthropic tool_use, a JSON string for OpenAI chat and the Responses API.
   */
  toolInput?: unknown
  /**
   * Who wrote a conversation slot: the message's role as the request carries
   * it (`user`, `assistant`, Gemini's `model`), and `user` for a bare
   * top-level `input` or `prompt` string. Only `user` text is the client's
   * own; an assistant turn is model output shaped by everything it read.
   */
  role?: string | undefined
  /** Writes `text` back into the payload in place. */
  set(text: string): void
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// Text part types across providers: Anthropic and chat `text`, Responses API
// `input_text` / `output_text`. Anything else (thinking, image, tool_use,
// document) is left alone; a thinking block's signature binds its bytes.
const TEXT_PARTS = new Set(['text', 'input_text', 'output_text'])

type SlotRef = Pick<TextSlot, 'toolCallId' | 'toolName' | 'toolInput' | 'role'>

// Tool call id to tool name and arguments, for the calls seen so far in one request.
type Calls = Map<string, { name: string; input: unknown }>

const ref = (id: unknown, calls: Calls): SlotRef => {
  if (typeof id !== 'string') return {}
  const call = calls.get(id)
  return { toolCallId: id, toolName: call?.name, toolInput: call?.input }
}

function fieldSlot(kind: SlotKind, holder: Obj, key: string, tool: SlotRef = {}): TextSlot {
  return {
    kind,
    text: holder[key] as string,
    ...tool,
    set(text) { holder[key] = text; this.text = text },
  }
}

function textParts(kind: SlotKind, parts: unknown[], out: TextSlot[], tool?: SlotRef): void {
  for (const part of parts) {
    if (isObj(part) && typeof part.text === 'string' && (part.type === undefined || TEXT_PARTS.has(part.type as string))) {
      out.push(fieldSlot(kind, part, 'text', tool))
    }
  }
}

// `content` of a message or of a tool_result block: a string or text parts.
function content(kind: SlotKind, holder: Obj, out: TextSlot[], tool?: SlotRef): void {
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
      calls.set(call.id, { name: call.function.name, input: call.function.arguments })
    }
  }
}

function message(m: unknown, out: TextSlot[], calls: Calls): void {
  if (!isObj(m)) return
  // Responses API tool call and tool output items.
  if (m.type === 'function_call') {
    if (typeof m.call_id === 'string' && typeof m.name === 'string') calls.set(m.call_id, { name: m.name, input: m.arguments })
    return
  }
  if (m.type === 'function_call_output') {
    if (typeof m.output === 'string') out.push(fieldSlot('tool_result', m, 'output', ref(m.call_id, calls)))
    return
  }
  if (Array.isArray(m.tool_calls)) chatCalls(m.tool_calls, calls)
  const kind = roleKind(m.role)
  const tool = kind === 'tool_result' ? ref(m.tool_call_id, calls) : typeof m.role === 'string' ? { role: m.role } : {}
  if (typeof m.content === 'string') {
    out.push(fieldSlot(kind, m, 'content', tool))
    return
  }
  if (!Array.isArray(m.content)) return
  for (const part of m.content) {
    if (!isObj(part)) continue
    if (part.type === 'tool_use') {
      if (typeof part.id === 'string' && typeof part.name === 'string') calls.set(part.id, { name: part.name, input: part.input })
    } else if (part.type === 'tool_result') {
      content('tool_result', part, out, ref(part.tool_use_id, calls))
    } else if (part.type === 'tool_addition') {
      // A tool added mid-conversation (Claude Code on a server-side thread).
      toolDefinition(part.tool, out)
    } else if (isObj(part.toolUse)) {
      // Bedrock Converse (#917): a call, a result, and untyped text blocks.
      const tu = part.toolUse
      if (typeof tu.toolUseId === 'string' && typeof tu.name === 'string') calls.set(tu.toolUseId, { name: tu.name, input: tu.input })
    } else if (isObj(part.toolResult)) {
      if (Array.isArray(part.toolResult.content)) textParts('tool_result', part.toolResult.content, out, ref(part.toolResult.toolUseId, calls))
    } else if (part.type === undefined && typeof part.text === 'string' && Object.keys(part).length === 1) {
      out.push(fieldSlot(kind, part, 'text', tool))
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
  // OpenAI chat nests the function; Bedrock Converse a toolSpec (#917).
  const fn = isObj(tool.function) ? tool.function : isObj(tool.toolSpec) ? tool.toolSpec : tool
  if (typeof fn.description === 'string') out.push(fieldSlot('tool_definition', fn, 'description'))
  // Bedrock's schema is under inputSchema.json, Cohere v1's parameters under parameter_definitions.
  const bedrockSchema = isObj(fn.inputSchema) ? fn.inputSchema.json : undefined
  schemaDescriptions(fn.input_schema ?? fn.parameters ?? bedrockSchema ?? fn.parameter_definitions, out)
}

/**
 * The text slots of a provider request, in the order the provider renders
 * them: tool definitions, then system text, then the conversation.
 */
export function collectTextSlots(payload: unknown): TextSlot[] {
  if (!isObj(payload)) return []
  const out: TextSlot[] = []

  if (Array.isArray(payload.tools)) for (const tool of payload.tools) toolDefinition(tool, out)
  if (isObj(payload.toolConfig) && Array.isArray(payload.toolConfig.tools)) for (const tool of payload.toolConfig.tools) toolDefinition(tool, out)

  if (typeof payload.system === 'string') out.push(fieldSlot('system', payload, 'system'))
  else if (Array.isArray(payload.system)) textParts('system', payload.system, out)
  if (typeof payload.instructions === 'string') out.push(fieldSlot('system', payload, 'instructions'))
  if (typeof payload.preamble === 'string') out.push(fieldSlot('system', payload, 'preamble'))
  // Gemini's JSON mapping accepts the proto name as well (#946).
  for (const key of ['systemInstruction', 'system_instruction'] as const) {
    const si = payload[key]
    if (typeof si === 'string') out.push(fieldSlot('system', payload, key))
    else if (isObj(si) && Array.isArray(si.parts)) textParts('system', si.parts, out)
  }

  const calls: Calls = new Map()
  if (Array.isArray(payload.messages)) for (const m of payload.messages) message(m, out, calls)
  if (typeof payload.input === 'string') out.push(fieldSlot('prompt', payload, 'input', { role: 'user' }))
  else if (Array.isArray(payload.input)) for (const m of payload.input) message(m, out, calls)
  if (Array.isArray(payload.contents)) {
    for (const item of payload.contents) {
      // Gemini defaults a turn without a role to the user.
      if (isObj(item) && Array.isArray(item.parts)) textParts('prompt', item.parts, out, { role: typeof item.role === 'string' ? item.role : 'user' })
    }
  }
  if (typeof payload.prompt === 'string') out.push(fieldSlot('prompt', payload, 'prompt', { role: 'user' }))
  cohereV1(payload, out)

  return out
}

// Cohere v1 chat (#917): the history, then the newest message, then the
// results of the calls the last answer made, each with its call.
const COHERE_ROLES: Record<string, string> = { user: 'user', chatbot: 'assistant' }
function cohereV1(payload: Obj, out: TextSlot[]): void {
  if (Array.isArray(payload.chat_history)) {
    for (const turn of payload.chat_history) {
      if (!isObj(turn) || typeof turn.message !== 'string') continue
      const role = typeof turn.role === 'string' ? turn.role.toLowerCase() : ''
      if (role === 'system') out.push(fieldSlot('system', turn, 'message'))
      else if (role !== 'tool') out.push(fieldSlot('prompt', turn, 'message', { role: COHERE_ROLES[role] ?? role }))
    }
  }
  if (typeof payload.message === 'string') out.push(fieldSlot('prompt', payload, 'message', { role: 'user' }))
  if (Array.isArray(payload.tool_results)) {
    for (const tr of payload.tool_results) {
      if (!isObj(tr) || !Array.isArray(tr.outputs)) continue
      const call = isObj(tr.call) ? tr.call : {}
      textParts('tool_result', tr.outputs, out, { toolName: typeof call.name === 'string' ? call.name : undefined, toolInput: call.parameters })
    }
  }
}
