import { describe, it, expect } from 'vitest'
import { ToolFilterModule } from '../../src/modules/builtin/toolFilter.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `The ${name} tool. `.repeat(20),
  input_schema: { type: 'object', properties: { x: { type: 'string' } } },
  ...extra,
})

const filter = (dropTools: string[]) => new ToolFilterModule({ enabled: true, dropTools })
const names = (body: string): string[] => (JSON.parse(body).tools as Array<{ name: string }>).map(t => t.name)

describe('ToolFilterModule', () => {
  const anthropic = (extra: Record<string, unknown> = {}) => JSON.stringify({
    tools: [tool('Bash'), tool('NotebookEdit'), tool('mcp__axiom__query'), tool('mcp__axiom__eval'), tool('Edit')],
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  })

  it('drops tools by name and by glob, and keeps the rest in order', () => {
    const res = filter(['NotebookEdit', 'mcp__axiom__*']).transformRequest(anthropic(), ctx)
    expect(res.modified).toBe(true)
    expect(names(res.body)).toEqual(['Bash', 'Edit'])
    expect(JSON.parse(res.body).messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('matches a glob against the whole name', () => {
    const res = filter(['axiom*']).transformRequest(anthropic(), ctx)
    expect(res.modified).toBe(false)
  })

  it('counts the dropped definitions as the saving', () => {
    const mod = filter(['NotebookEdit'])
    mod.transformRequest(anthropic(), ctx)
    const stats = mod.getStats()
    expect(stats.tokensOriginal).toBeGreaterThan(stats.tokensPruned)
    expect(stats.tokensSaved).toBeGreaterThan(50)
    expect(stats.kpis).toContainEqual(expect.objectContaining({ key: 'dropped', value: 1 }))
  })

  it('drops the same tools on every turn of a growing conversation', () => {
    const turn1 = filter(['NotebookEdit']).transformRequest(anthropic(), ctx).body
    const turn2 = filter(['NotebookEdit']).transformRequest(anthropic({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    }), ctx).body
    expect(JSON.parse(turn2).tools).toEqual(JSON.parse(turn1).tools)
  })

  it('keeps a tool the conversation already calls', () => {
    const res = filter(['NotebookEdit']).transformRequest(anthropic({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'NotebookEdit', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    }), ctx)
    expect(res.modified).toBe(false)
  })

  it('keeps a tool named in tool_choice', () => {
    const res = filter(['NotebookEdit', 'Edit']).transformRequest(anthropic({ tool_choice: { type: 'tool', name: 'NotebookEdit' } }), ctx)
    expect(names(res.body)).toEqual(['Bash', 'NotebookEdit', 'mcp__axiom__query', 'mcp__axiom__eval'])
  })

  it('keeps a tool that carries a cache breakpoint', () => {
    const body = JSON.stringify({
      tools: [tool('Bash'), tool('NotebookEdit', { cache_control: { type: 'ephemeral' } })],
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(filter(['NotebookEdit']).transformRequest(body, ctx).modified).toBe(false)
  })

  it('leaves the request alone when every tool would go', () => {
    expect(filter(['*']).transformRequest(anthropic(), ctx).modified).toBe(false)
  })

  it('filters OpenAI chat tools, keeping one its history calls', () => {
    const fn = (name: string) => ({ type: 'function', function: { name, description: 'd', parameters: { type: 'object' } } })
    const body = JSON.stringify({
      tools: [fn('search'), fn('browse'), fn('shell')],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browse', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
    })
    const res = filter(['browse', 'shell']).transformRequest(body, { ...ctx, target: 'api.openai.com', path: '/v1/chat/completions' })
    expect((JSON.parse(res.body).tools as Array<{ function: { name: string } }>).map(t => t.function.name)).toEqual(['search', 'browse'])
  })

  it('filters Responses API tools, keeping the one tool_choice names', () => {
    const fn = (name: string) => ({ type: 'function', name, description: 'd', parameters: { type: 'object' } })
    const body = JSON.stringify({
      tools: [fn('search'), fn('browse'), fn('shell'), { type: 'web_search' }],
      tool_choice: { type: 'function', name: 'shell' },
      input: [{ role: 'user', content: 'hi' }, { type: 'function_call', call_id: 'c1', name: 'search', arguments: '{}' }],
    })
    const res = filter(['search', 'browse', 'shell']).transformRequest(body, { ...ctx, target: 'api.openai.com', path: '/v1/responses' })
    expect(JSON.parse(res.body).tools.map((t: { name?: string, type: string }) => t.name ?? t.type)).toEqual(['search', 'shell', 'web_search'])
  })

  it('filters Gemini function declarations and drops an emptied tool entry', () => {
    const decl = (name: string) => ({ name, description: 'd' })
    const body = JSON.stringify({
      tools: [{ functionDeclarations: [decl('search'), decl('browse')] }, { functionDeclarations: [decl('shell')] }],
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    })
    const res = filter(['browse', 'shell']).transformRequest(body, { ...ctx, target: 'generativelanguage.googleapis.com', path: '/v1beta/models/gemini:generateContent' })
    expect(JSON.parse(res.body).tools).toEqual([{ functionDeclarations: [decl('search')] }])
  })

  it('does nothing while off, with no names, or without a tool list', () => {
    expect(new ToolFilterModule({ enabled: false, dropTools: ['Bash'] }).transformRequest(anthropic(), ctx).modified).toBe(false)
    expect(filter([]).transformRequest(anthropic(), ctx).modified).toBe(false)
    const thread = JSON.stringify({ thread: { type: 'continue', previous_message_id: 'm1' }, messages: [{ role: 'user', content: 'hi' }] })
    expect(filter(['Bash']).transformRequest(thread, ctx).modified).toBe(false)
  })
})
