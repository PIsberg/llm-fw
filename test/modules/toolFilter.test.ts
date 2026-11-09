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

const filter = (dropTools: string[]) => new ToolFilterModule({ enabled: true, dropTools, shortenTools: [], shortenTo: 200 })
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

  it('matches several stars, a star at either end, and regex characters literally', () => {
    const body = JSON.stringify({
      tools: [tool('mcp__a__x__run'), tool('mcp__b__run'), tool('Cron.Create'), tool('CronXCreate'), tool('Keep')],
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(names(filter(['mcp__*__*__run', 'Cron.Create', '*eep*x']).transformRequest(body, ctx).body))
      .toEqual(['mcp__b__run', 'CronXCreate', 'Keep'])
    expect(names(filter(['*run', 'Cron*']).transformRequest(body, ctx).body)).toEqual(['Keep'])
  })

  // dropTools is turned into a matcher, so a pattern with many stars must not
  // backtrack on a long name that almost matches.
  it('stays linear on a many-star pattern against a long near-miss name', () => {
    const long = 'a'.repeat(4000)
    const body = JSON.stringify({ tools: [tool(long), tool('Keep')], messages: [{ role: 'user', content: 'hi' }] })
    const started = performance.now()
    const res = filter(['a*a*a*a*a*a*a*a*a*a*b']).transformRequest(body, ctx)
    expect(performance.now() - started).toBeLessThan(250)
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
    expect(new ToolFilterModule({ enabled: false, dropTools: ['Bash'], shortenTools: ['Bash'], shortenTo: 200 }).transformRequest(anthropic(), ctx).modified).toBe(false)
    expect(filter([]).transformRequest(anthropic(), ctx).modified).toBe(false)
    const thread = JSON.stringify({ thread: { type: 'continue', previous_message_id: 'm1' }, messages: [{ role: 'user', content: 'hi' }] })
    expect(filter(['Bash']).transformRequest(thread, ctx).modified).toBe(false)
  })
})

// shortenTools: the tool stays callable, its definition is cut to a stub
// until the conversation calls it.
describe('ToolFilterModule shortenTools', () => {
  const long = (lead: string) => `${lead}\n\n${'Detailed guidance that only matters once the tool is in use. '.repeat(40)}`
  const big = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    description: long(`Publishes a page with ${name}.`),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['publish', 'read'], description: long('What to do.') },
        description: { type: 'string', description: long('A subtitle.') },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string', description: long('Where the file is.') } } } },
        mode: { anyOf: [{ type: 'string', description: long('A named mode.') }, { type: 'null' }], default: { description: long('not a schema') } },
      },
      required: ['action'],
    },
    ...extra,
  })
  const small = (name: string) => ({ name, description: 'Runs a command.', input_schema: { type: 'object', properties: { x: { type: 'string', description: 'The command.' } } } })
  const shortener = (shortenTools: string[], more: Record<string, unknown> = {}) => new ToolFilterModule({ enabled: true, dropTools: [], shortenTools, shortenTo: 200, ...more })
  const request = (extra: Record<string, unknown> = {}) => JSON.stringify({
    tools: [small('Bash'), big('Artifact'), big('Workflow')],
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  })
  type Def = ReturnType<typeof big>
  const defs = (body: string) => JSON.parse(body).tools as Def[]
  const called = (name: string) => [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ]

  it('cuts a named tool to the first paragraph of its description and says so', () => {
    const res = shortener(['Artifact']).transformRequest(request(), ctx)
    expect(res.modified).toBe(true)
    const [bash, artifact, workflow] = defs(res.body)
    expect(artifact!.description).toBe('Publishes a page with Artifact. [llm-fw: description shortened]')
    expect(bash).toEqual(small('Bash'))
    expect(workflow).toEqual(big('Workflow'))
  })

  it('keeps the name, the schema structure, enums and required, and shortens parameter descriptions', () => {
    const [, artifact] = defs(shortener(['Artifact']).transformRequest(request(), ctx).body)
    const props = artifact!.input_schema.properties
    expect(artifact!.name).toBe('Artifact')
    expect(artifact!.input_schema.required).toEqual(['action'])
    expect(props.action).toEqual({ type: 'string', enum: ['publish', 'read'], description: 'What to do.' })
    // A parameter that is itself named "description" keeps its schema.
    expect(props.description).toEqual({ type: 'string', description: 'A subtitle.' })
    expect(props.files.items.properties.path.description).toBe('Where the file is.')
    expect(props.mode.anyOf[0]!.description).toBe('A named mode.')
    // A default is data, not a schema.
    expect(props.mode.default).toEqual({ description: long('not a schema') })
  })

  it('caps a first paragraph longer than shortenTo at a word', () => {
    const body = JSON.stringify({ tools: [small('Bash'), { name: 'Wordy', description: 'word '.repeat(400), input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }] })
    const wordy = defs(shortener(['Wordy'], { shortenTo: 50 }).transformRequest(body, ctx).body)[1]!
    expect(wordy.description).toBe(`${'word '.repeat(10).trimEnd()} [llm-fw: description shortened]`)
  })

  it('leaves a definition that is already short alone', () => {
    expect(shortener(['Bash']).transformRequest(request(), ctx).modified).toBe(false)
  })

  it('sends the whole definition once the conversation has called the tool, or tool_choice names it', () => {
    const afterCall = shortener(['Artifact', 'Workflow']).transformRequest(request({ messages: called('Artifact') }), ctx)
    expect(defs(afterCall.body)[1]).toEqual(big('Artifact'))
    expect(defs(afterCall.body)[2]!.description).toMatch(/shortened\]$/)
    const forced = shortener(['Artifact']).transformRequest(request({ tool_choice: { type: 'tool', name: 'Artifact' } }), ctx)
    expect(forced.modified).toBe(false)
  })

  it('sends the same tool list on every turn that has not called the tool', () => {
    const turn1 = shortener(['Artifact']).transformRequest(request(), ctx).body
    const turn2 = shortener(['Artifact']).transformRequest(request({ messages: called('Bash') }), ctx).body
    expect(JSON.parse(turn2).tools).toEqual(JSON.parse(turn1).tools)
  })

  it('shortens a tool that carries the cache breakpoint, and keeps the breakpoint', () => {
    const body = JSON.stringify({ tools: [small('Bash'), big('Artifact', { cache_control: { type: 'ephemeral' } })], messages: [{ role: 'user', content: 'hi' }] })
    const artifact = defs(shortener(['Artifact']).transformRequest(body, ctx).body)[1]! as Def & { cache_control: unknown }
    expect(artifact.description).toMatch(/shortened\]$/)
    expect(artifact.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('drops a tool named in both lists', () => {
    const res = shortener(['Artifact', 'Workflow'], { dropTools: ['Artifact'] }).transformRequest(request(), ctx)
    expect(defs(res.body).map(t => t.name)).toEqual(['Bash', 'Workflow'])
    expect(defs(res.body)[1]!.description).toMatch(/shortened\]$/)
  })

  it('counts the saving and the shortened definitions', () => {
    const mod = shortener(['Artifact', 'Workflow'])
    mod.transformRequest(request(), ctx)
    const stats = mod.getStats()
    expect(stats.tokensSaved).toBeGreaterThan(0.75 * stats.tokensOriginal)
    expect(stats.kpis).toContainEqual(expect.objectContaining({ key: 'shortened', value: 2 }))
    expect(stats.kpis).toContainEqual(expect.objectContaining({ key: 'dropped', value: 0 }))
  })

  it('shortens OpenAI chat, Responses API and Gemini declarations', () => {
    const chat = JSON.stringify({ tools: [{ type: 'function', function: { name: 'browse', description: long('Opens a page.'), parameters: { type: 'object', properties: { url: { type: 'string', description: long('The address.') } } } } }], messages: [{ role: 'user', content: 'hi' }] })
    const chatFn = JSON.parse(shortener(['browse']).transformRequest(chat, { ...ctx, target: 'api.openai.com', path: '/v1/chat/completions' }).body).tools[0].function
    expect(chatFn.description).toBe('Opens a page. [llm-fw: description shortened]')
    expect(chatFn.parameters.properties.url.description).toBe('The address.')

    const responses = JSON.stringify({ tools: [{ type: 'function', name: 'browse', description: long('Opens a page.'), parameters: { type: 'object' } }, { type: 'web_search' }], input: [{ role: 'user', content: 'hi' }] })
    const tools = JSON.parse(shortener(['*']).transformRequest(responses, { ...ctx, target: 'api.openai.com', path: '/v1/responses' }).body).tools
    expect(tools[0].description).toBe('Opens a page. [llm-fw: description shortened]')
    expect(tools[1]).toEqual({ type: 'web_search' })

    const gemini = JSON.stringify({ tools: [{ functionDeclarations: [{ name: 'browse', description: long('Opens a page.'), parameters: { type: 'OBJECT', properties: { url: { type: 'STRING', description: long('The address.') } } } }, { name: 'shell', description: long('Runs it.') }] }], contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    const decls = JSON.parse(shortener(['browse']).transformRequest(gemini, { ...ctx, target: 'generativelanguage.googleapis.com', path: '/v1beta/models/gemini:generateContent' }).body).tools[0].functionDeclarations
    expect(decls[0].description).toBe('Opens a page. [llm-fw: description shortened]')
    expect(decls[0].parameters.properties.url.description).toBe('The address.')
    expect(decls[1].description).toBe(long('Runs it.'))
  })

  it('stays linear on a huge description and a deep, wide schema', () => {
    let schema: Record<string, unknown> = { type: 'string', description: long('Leaf.') }
    for (let i = 0; i < 400; i++) schema = { type: 'object', properties: { p: schema, ...Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`q${n}`, { type: 'string', description: long('Wide.') }])) } }
    const body = JSON.stringify({ tools: [small('Bash'), { name: 'Deep', description: `${' \n'.repeat(100_000)}x`, input_schema: schema }], messages: [{ role: 'user', content: 'hi' }] })
    const started = performance.now()
    const res = shortener(['Deep']).transformRequest(body, ctx)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(res.modified).toBe(true)
  })
})
