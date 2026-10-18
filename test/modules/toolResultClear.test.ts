import { describe, it, expect } from 'vitest'
import { ToolResultClearModule } from '../../src/modules/builtin/toolResultClear.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import type { CapturedResponse } from '../../src/modules/responseTap.js'
import type { ToolResultClearConfig } from '../../src/types.js'

// The beta list Claude Code sent on 2026-10-18, abridged.
const BETA = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,claude-code-20250219'
const anthropic: GatewayModuleContext = {
  target: 'api.anthropic.com', method: 'POST', path: '/v1/messages?beta=true', isLlmRequest: true, parser: null,
  headers: { 'anthropic-beta': BETA },
}
const cfg = (extra: Partial<ToolResultClearConfig> = {}): ToolResultClearConfig => ({
  enabled: true, triggerTokens: 100000, keepToolUses: 10, clearAtLeast: 20000, excludeTools: [], ...extra,
})
const request = (extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
})
const send = (mod: ToolResultClearModule, payload: unknown, ctx = anthropic) => mod.transformRequest(JSON.stringify(payload), ctx)
const kpi = (mod: ToolResultClearModule, key: string) => mod.getStats().kpis?.find(k => k.key === key)?.value
const EDIT = {
  type: 'clear_tool_uses_20250919',
  trigger: { type: 'input_tokens', value: 100000 },
  keep: { type: 'tool_uses', value: 10 },
  clear_at_least: { type: 'input_tokens', value: 20000 },
}
const sse = (...events: unknown[]): CapturedResponse => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: Buffer.from(events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')),
})

describe('ToolResultClearModule', () => {
  it('asks the server to clear old tool results', () => {
    const res = send(new ToolResultClearModule(cfg()), request())
    expect(res.modified).toBe(true)
    expect(JSON.parse(res.body).context_management).toEqual({ edits: [EDIT] })
  })

  it('appends to the edits the client already sends, after its thinking edit', () => {
    // Claude Code sends clear_thinking, which the API requires to come first.
    const thinking = { type: 'clear_thinking_20251015', keep: 'all' }
    const out = JSON.parse(send(new ToolResultClearModule(cfg()), request({ context_management: { edits: [thinking] } })).body)
    expect(out.context_management.edits).toEqual([thinking, EDIT])
  })

  it('passes excluded tools and leaves out a zero clear_at_least', () => {
    const out = JSON.parse(send(new ToolResultClearModule(cfg({ clearAtLeast: 0, excludeTools: ['Read'] })), request()).body)
    const { clear_at_least: _, ...rest } = EDIT
    expect(out.context_management.edits).toEqual([{ ...rest, exclude_tools: ['Read'] }])
  })

  it('leaves a client that clears tool results itself alone', () => {
    const mod = new ToolResultClearModule(cfg())
    const own = { type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 3 } }
    expect(send(mod, request({ context_management: { edits: [own] } })).modified).toBe(false)
    expect(kpi(mod, 'clientManaged')).toBe(1)
  })

  it('does nothing without the context-management beta, which the API needs to accept the field', () => {
    // Verified 2026-10-18: without it the API answers 400 "context_management:
    // Extra inputs are not permitted".
    const mod = new ToolResultClearModule(cfg())
    for (const headers of [{}, { 'anthropic-beta': 'oauth-2025-04-20' }, undefined]) {
      expect(send(mod, request(), { ...anthropic, headers }).modified).toBe(false)
    }
    expect(send(mod, request(), { ...anthropic, headers: { 'anthropic-beta': ['oauth-2025-04-20', 'context-management-2025-06-27'] } }).modified).toBe(true)
    expect(kpi(mod, 'noBeta')).toBe(3)
  })

  it('only touches Anthropic Messages requests', () => {
    const mod = new ToolResultClearModule(cfg())
    expect(send(mod, request(), { ...anthropic, target: 'api.openai.com', path: '/v1/chat/completions' }).modified).toBe(false)
    expect(send(mod, request(), { ...anthropic, path: '/v1/messages/count_tokens' }).modified).toBe(false)
    expect(send(mod, { prompt: 'x' }).modified).toBe(false)
  })

  it('adds the same edit on every turn, so the request prefix stays byte-identical', () => {
    const mod = new ToolResultClearModule(cfg())
    const a = send(mod, request()).body
    const b = send(mod, request()).body
    expect(a).toBe(b)
  })

  it('counts what the server reports clearing, streamed and not', () => {
    const mod = new ToolResultClearModule(cfg())
    const applied = { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_input_tokens: 9331, cleared_tool_uses: 2 }] }
    mod.observeResponse('{}', anthropic, sse(
      { type: 'message_start', message: { id: 'm', context_management: null, usage: { input_tokens: 2 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, context_management: applied, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ))
    mod.observeResponse('{}', anthropic, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ id: 'm2', content: [], context_management: applied })) })
    mod.observeResponse('{}', anthropic, sse({ type: 'message_delta', delta: {}, context_management: { applied_edits: [{ type: 'clear_thinking_20251015', cleared_input_tokens: 50 }] } }))
    expect(kpi(mod, 'clearedTokens')).toBe(18662)
    expect(kpi(mod, 'clearedToolUses')).toBe(4)
    expect(kpi(mod, 'responsesCleared')).toBe(2)
  })

  it('counts a dry run in observe mode without claiming it was sent', () => {
    const mod = new ToolResultClearModule(cfg())
    send(mod, request(), { ...anthropic, dryRun: true })
    expect(kpi(mod, 'wouldMark')).toBe(1)
    expect(kpi(mod, 'marked')).toBe(0)
  })
})
