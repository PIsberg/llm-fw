import type { CapturedResponse } from './responseTap.js'
import { responseEvents } from './usage.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A tool call a response made, with its arguments as the provider sent them. */
export interface ToolCall {
  id: string
  name: string
  /** An object for Anthropic tool_use, a JSON string for the Responses API and a streamed tool_use. */
  input: unknown
}

/**
 * Every tool call in a response's events: Anthropic tool_use blocks (a whole
 * message, or content_block_start events whose input arrives as
 * input_json_delta fragments) and Responses API function_call items (a whole
 * response, response.completed, or the output_item events). OpenAI chat and
 * Gemini resend every call with its result, so the request itself names the
 * tool.
 */
function responseToolCalls(events: unknown[]): ToolCall[] {
  const out: ToolCall[] = []
  // Streamed tool_use blocks by content index, with their input so far.
  const streamed = new Map<number, { call: ToolCall; json: string }>()
  for (const event of events) {
    if (!isObj(event)) continue
    const delta = event.delta
    if (event.type === 'content_block_delta' && typeof event.index === 'number' && isObj(delta) && typeof delta.partial_json === 'string') {
      const open = streamed.get(event.index)
      if (open) open.json += delta.partial_json
      continue
    }
    const response = isObj(event.response) ? event.response : event
    const items = Array.isArray(event.content) ? event.content
      : Array.isArray(response.output) ? response.output
      : [event.content_block, event.item]
    for (const item of items) {
      if (!isObj(item) || typeof item.name !== 'string') continue
      if (item.type === 'tool_use' && typeof item.id === 'string') {
        const call = { id: item.id, name: item.name, input: item.input }
        out.push(call)
        if (event.type === 'content_block_start' && typeof event.index === 'number') streamed.set(event.index, { call, json: '' })
      } else if (item.type === 'function_call' && typeof item.call_id === 'string') {
        out.push({ id: item.call_id, name: item.name, input: item.arguments })
      }
    }
  }
  for (const { call, json } of streamed.values()) if (json) call.input = json
  return out
}

/**
 * A shell call's command as one line: a string as it is (Claude Code's Bash,
 * Gemini CLI's run_shell_command), an argv array joined with spaces (Codex's
 * shell: `["bash", "-lc", "npm test"]`). Undefined for any other shape.
 */
export function commandText(command: unknown): string | undefined {
  if (typeof command === 'string') return command
  if (Array.isArray(command) && command.length > 0 && command.every(c => typeof c === 'string')) return command.join(' ')
  return undefined
}

/**
 * True when a word of `command` is one of `skipCommands`, compared by its
 * basename without `.exe`; an entry with a hyphen (a PowerShell cmdlet such
 * as Get-Content) matches in any case. Any word counts, a pipeline stage or
 * an argument alike, so a doubtful command is treated as a file read, and so
 * is the script behind `bash -lc`.
 */
export function isFileRead(command: string, skipCommands: readonly string[]): boolean {
  for (const word of command.split(/[\s;&|()<>`$"'{}]+/)) {
    const base = (word.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')
    if (!base) continue
    if (skipCommands.some(skip => skip === base || (skip.includes('-') && skip.toLowerCase() === base.toLowerCase()))) return true
  }
  return false
}

/** A call's arguments as an object: Anthropic's as they are, a JSON string parsed. */
export function toolArgs(input: unknown): Obj | undefined {
  if (isObj(input)) return input
  if (typeof input !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(input)
    return isObj(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// A thread continuation answers the calls of the response just before it, so
// this covers many sessions at once.
const MAX_REMEMBERED = 4096

/**
 * Tool calls learned from responses, oldest evicted first. A request that
 * continues a server-side thread (Claude Code through the proxy, the
 * Responses API with previous_response_id) carries tool results without the
 * calls, which the provider keeps. Ids are unique per call, so one map serves
 * every client: a forged id only decides what happens to the forger's own
 * result.
 */
export class RememberedCalls {
  private readonly calls = new Map<string, ToolCall>()

  learn(response: CapturedResponse): void {
    for (const call of responseToolCalls(responseEvents(response.body, response.headers) ?? [])) {
      this.calls.delete(call.id)
      this.calls.set(call.id, call)
      if (this.calls.size > MAX_REMEMBERED) this.calls.delete(this.calls.keys().next().value!)
    }
  }

  get(id: string | undefined): ToolCall | undefined {
    return id === undefined ? undefined : this.calls.get(id)
  }
}

/** Every tool call a captured response made. */
export function responseCalls(response: CapturedResponse): ToolCall[] {
  return responseToolCalls(responseEvents(response.body, response.headers) ?? [])
}
