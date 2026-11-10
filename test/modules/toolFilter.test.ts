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

const filter = (dropTools: string[]) => new ToolFilterModule({ enabled: true, dropTools, shortenTools: [], shortenTo: 200, dropSkills: [] })
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
    expect(new ToolFilterModule({ enabled: false, dropTools: ['Bash'], shortenTools: ['Bash'], shortenTo: 200, dropSkills: ['x'] }).transformRequest(anthropic(), ctx).modified).toBe(false)
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
  const shortener = (shortenTools: string[], more: Record<string, unknown> = {}) => new ToolFilterModule({ enabled: true, dropTools: [], shortenTools, shortenTo: 200, dropSkills: [], ...more })
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

  it('sends the whole definition again when a server-side thread restarts after a call (#744)', () => {
    // Claude Code 2.1.322 through the proxy, captured 2026-11-10: a thread
    // starts with the tool list, its continuations carry neither the list
    // nor the calls, and the next user prompt starts a new thread with the
    // whole history, system messages among it, and the list again.
    const sys = { role: 'system', content: [{ type: 'text', text: 'reminder' }] }
    const start = shortener(['Artifact']).transformRequest(request({ thread: { type: 'create' }, messages: [{ role: 'user', content: 'hi' }, sys] }), ctx)
    expect(defs(start.body)[1]!.description).toMatch(/shortened\]$/)
    const cont = JSON.stringify({ thread: { type: 'continue', previous_message_id: 'msg_1' }, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, sys] })
    expect(shortener(['Artifact']).transformRequest(cont, ctx).modified).toBe(false)
    const [hi, use, result] = called('Artifact')
    const restart = shortener(['Artifact']).transformRequest(request({ thread: { type: 'create' }, messages: [hi, sys, use, result, sys, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next' }, sys] }), ctx)
    expect(defs(restart.body)[1]).toEqual(big('Artifact'))
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

  // 200 KB of blank lines in one description, and a schema 200 levels deep
  // with 4,000 parameter descriptions: about 1 MB of definitions. A cut that
  // rescanned the text per position, or a walk that revisited nodes, takes
  // far longer than the second this allows.
  it('stays linear on a huge description and a deep, wide schema', () => {
    const wordy = (lead: string) => `${lead}\n\n${'x'.repeat(200)}`
    let schema: Record<string, unknown> = { type: 'string', description: wordy('Leaf.') }
    for (let i = 0; i < 200; i++) schema = { type: 'object', properties: { p: schema, ...Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`q${n}`, { type: 'string', description: wordy('Wide.') }])) } }
    const body = JSON.stringify({ tools: [small('Bash'), { name: 'Deep', description: `${' \n'.repeat(100_000)}x`, input_schema: schema }], messages: [{ role: 'user', content: 'hi' }] })
    const mod = shortener(['Deep'])
    const started = performance.now()
    const res = mod.transformRequest(body, ctx)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(res.modified).toBe(true)
    const deep = JSON.parse(res.body).tools[1]
    expect(deep.description).toBe('x [llm-fw: description shortened]')
    expect(JSON.stringify(deep)).not.toContain('xxxx')
  })
})

// dropSkills: Claude Code lists every installed skill, one line each, in a
// system message it sends with every conversation. On one developer's
// requests that listing was 24,663 characters, and 63 of the 93 skills in it
// were never invoked in 30 days.
describe('ToolFilterModule dropSkills', () => {
  const header = 'The following skills are available for use with the Skill tool:'
  const entries = [
    '- deslop: Remove AI writing patterns from prose.',
    '- claude-api: Reference for the Claude API.\nTRIGGER - read FIRST, before you answer: the prompt names Claude.\nSKIP only when another provider is being worked on.',
    '- speckit-plan: Execute the implementation planning workflow.',
    '- speckit-tasks: Generate a dependency-ordered tasks.md.',
    '- anthropic-skills:pdf',
    '- anthropic-skills:docx: Word documents.',
  ]
  const listing = (kept: string[] = entries) => `# Environment\n - Platform: win32\n\n${header}\n\n${kept.join('\n')}\n\nToday's date is 2026-11-09.`
  const systemMessage = (text: string) => ({ role: 'system', content: [{ type: 'text', text }, { type: 'tool_addition', tools: [] }] })
  const request = (messages: unknown[]) => JSON.stringify({ tools: [tool('Bash'), tool('Skill')], messages })
  const skills = (dropSkills: string[], more: Record<string, unknown> = {}) => new ToolFilterModule({ enabled: true, dropTools: [], shortenTools: [], shortenTo: 200, dropSkills, ...more })
  const textOf = (body: string, message = 1, block = 0): string => JSON.parse(body).messages[message].content[block].text
  const typed = { role: 'user', content: [{ type: 'text', text: 'hi' }] }

  it('removes the named skills from the listing, with the lines that continue them, and nothing else', () => {
    const res = skills(['claude-api', 'speckit-tasks']).transformRequest(request([typed, systemMessage(listing())]), ctx)
    expect(res.modified).toBe(true)
    expect(textOf(res.body)).toBe(listing([entries[0]!, entries[2]!, entries[4]!, entries[5]!]))
    const out = JSON.parse(res.body)
    expect(out.messages[0]).toEqual(typed)
    expect(out.messages[1].content[1]).toEqual({ type: 'tool_addition', tools: [] })
    expect(out.tools).toHaveLength(2)
  })

  it('matches a pattern over the whole name, a name with a colon, and an entry with no description', () => {
    const res = skills(['speckit-*', 'anthropic-skills:*']).transformRequest(request([typed, systemMessage(listing())]), ctx)
    expect(textOf(res.body)).toBe(listing([entries[0]!, entries[1]!]))
    expect(skills(['speckit']).transformRequest(request([typed, systemMessage(listing())]), ctx).modified).toBe(false)
  })

  it('removes the last entry without leaving a gap before what follows', () => {
    const res = skills(['anthropic-skills:docx']).transformRequest(request([typed, systemMessage(listing())]), ctx)
    expect(textOf(res.body)).toBe(listing(entries.slice(0, 5)))
  })

  it('reads the listing from a reminder in a user message, as a block or as a string', () => {
    const reminder = `<system-reminder>\n${listing()}\n</system-reminder>`
    const asBlock = skills(['deslop']).transformRequest(request([{ role: 'user', content: [{ type: 'text', text: reminder }, { type: 'text', text: 'hi' }] }]), ctx)
    expect(textOf(asBlock.body, 0)).toBe(`<system-reminder>\n${listing(entries.slice(1))}\n</system-reminder>`)
    const asString = skills(['deslop']).transformRequest(request([{ role: 'user', content: reminder }]), ctx)
    expect(JSON.parse(asString.body).messages[0].content).toBe(`<system-reminder>\n${listing(entries.slice(1))}\n</system-reminder>`)
  })

  // The header is ordinary text: a person can paste it, and a tool can print it.
  it('leaves a listing somebody typed, a tool printed or the model wrote alone', () => {
    const res = skills(['deslop']).transformRequest(request([
      { role: 'user', content: [{ type: 'text', text: listing() }] },
      { role: 'user', content: listing() },
      { role: 'assistant', content: [{ type: 'text', text: listing() }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `<system-reminder>\n${listing()}` }] }] },
    ]), ctx)
    expect(res.modified).toBe(false)
  })

  it('leaves the listing alone when every skill would go, and text that is not a listing', () => {
    expect(skills(['*']).transformRequest(request([typed, systemMessage(listing())]), ctx).modified).toBe(false)
    const prose = `${header} none of them matter.\n\n- deslop: x`
    expect(skills(['deslop']).transformRequest(request([typed, systemMessage(prose)]), ctx).modified).toBe(false)
    const preface = `${header}\n\nUse them sparingly.\n- deslop: x\n- other: y`
    expect(skills(['deslop']).transformRequest(request([typed, systemMessage(preface)]), ctx).modified).toBe(false)
  })

  it('sends a growing conversation the same listing, also after a dropped skill was invoked', () => {
    const one = skills(['deslop']).transformRequest(request([typed, systemMessage(listing())]), ctx).body
    const two = skills(['deslop']).transformRequest(request([
      typed, systemMessage(listing()),
      { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'deslop' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'loaded' }] },
    ]), ctx).body
    expect(textOf(two)).toBe(textOf(one))
  })

  it('works on a request with no tool list, and beside dropTools', () => {
    const noTools = JSON.stringify({ thread: { type: 'continue', previous_message_id: 'm1' }, messages: [systemMessage(listing())] })
    expect(JSON.parse(skills(['deslop']).transformRequest(noTools, ctx).body).messages[0].content[0].text).toBe(listing(entries.slice(1)))
    const both = skills(['deslop'], { dropTools: ['Bash'] }).transformRequest(request([typed, systemMessage(listing())]), ctx)
    expect(JSON.parse(both.body).tools.map((t: { name: string }) => t.name)).toEqual(['Skill'])
    expect(textOf(both.body)).toBe(listing(entries.slice(1)))
  })

  it('counts the removed lines as the saving, and the skills it dropped', () => {
    const mod = skills(['claude-api', 'speckit-*'])
    mod.transformRequest(request([typed, systemMessage(listing())]), ctx)
    const stats = mod.getStats()
    expect(stats.tokensSaved).toBeGreaterThan(20)
    expect(stats.kpis).toContainEqual(expect.objectContaining({ key: 'skillsDropped', value: 3 }))
  })

  it('does nothing with no names', () => {
    expect(skills([]).transformRequest(request([typed, systemMessage(listing())]), ctx).modified).toBe(false)
  })

  // #753: Claude Code 2.1.321 builds the listing's first sentence from a
  // template with four outcomes. A listing sent later in a conversation says
  // "also" and that it adds to the earlier one, and a client that loads
  // skills from scripts words the middle differently.
  describe('the four ways Claude Code words the listing', () => {
    const adds = '. This list adds to the skills listed earlier in this conversation and is not the full list'
    const script = 'available; a script loads one with `await tools.Skill({skill: "name"})`, and its instructions arrive as a message right after the script\'s result'
    const worded = (sentence: string, kept: string[] = entries) => `# Environment\n\n${sentence}:\n\n${kept.join('\n')}\n\nToday's date is 2026-11-10.`
    const sentences = {
      'a later listing': `The following skills are also available for use with the Skill tool${adds}`,
      'script mode': `The following skills are ${script}`,
      'a later listing in script mode': `The following skills are also ${script}${adds}`,
    }
    it.each(Object.entries(sentences))('removes the named skills from %s', (_name, sentence) => {
      const res = skills(['deslop', 'speckit-*']).transformRequest(request([typed, systemMessage(worded(sentence))]), ctx)
      expect(textOf(res.body)).toBe(worded(sentence, [entries[1]!, entries[4]!, entries[5]!]))
    })

    it('finds the listing after other text that starts the same way, and each listing of a conversation', () => {
      const first = `The following skills are not what this is about.\n\n${listing()}`
      const later = worded(sentences['a later listing'], ['- wizard: Generate a wizard.', '- deslop: again'])
      const res = skills(['deslop']).transformRequest(request([typed, systemMessage(first), typed, systemMessage(later)]), ctx)
      expect(textOf(res.body)).toBe(`The following skills are not what this is about.\n\n${listing(entries.slice(1))}`)
      expect(textOf(res.body, 3)).toBe(worded(sentences['a later listing'], ['- wizard: Generate a wizard.']))
    })

    it('leaves a sentence it does not know alone', () => {
      const reworded = worded('The following skills can be invoked with the Skill tool')
      expect(skills(['deslop']).transformRequest(request([typed, systemMessage(reworded)]), ctx).modified).toBe(false)
    })
  })

  // If a release rewords the sentence, dropSkills removes nothing and breaks
  // nothing. The card says so instead of staying silent.
  it('says when requests offer the Skill tool and none carries a listing it knows', () => {
    const mod = skills(['deslop'])
    const reworded = request([typed, systemMessage(`The following skills can be invoked:\n\n${entries.join('\n')}\n\nend`)])
    for (let i = 0; i < 19; i++) mod.transformRequest(reworded, ctx)
    expect(mod.getStats().detail).toBeUndefined()
    mod.transformRequest(reworded, ctx)
    expect(mod.getStats().detail).toMatch(/20 requests offered the Skill tool and none carried a skill listing/)
    // One listing in the known format, and the warning is gone.
    mod.transformRequest(request([typed, systemMessage(listing())]), ctx)
    expect(mod.getStats().detail).toBeUndefined()
    // A request without the Skill tool is no evidence either way.
    const quiet = skills(['deslop'])
    for (let i = 0; i < 30; i++) quiet.transformRequest(JSON.stringify({ tools: [tool('Bash')], messages: [typed] }), ctx)
    expect(quiet.getStats().detail).toBeUndefined()
  })

  // 200 KB of entries, of continuation lines, and of header copies: one pass each.
  it('stays linear on a huge listing and on repeated headers', () => {
    const many = Array.from({ length: 4000 }, (_, i) => `- skill-${i}: ${'does a thing. '.repeat(3)}`)
    const longEntry = `- wordy: start\n${'more\n'.repeat(40_000)}- last: end`
    const headers = `${header}\n`.repeat(3000)
    const body = request([typed, systemMessage(listing(many)), systemMessage(`${header}\n\n${longEntry}\n\nend`), systemMessage(headers)])
    const mod = skills(['skill-1*', 'wordy'])
    const started = performance.now()
    const res = mod.transformRequest(body, ctx)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(textOf(res.body, 2)).toBe(`${header}\n\n- last: end\n\nend`)
    expect(textOf(res.body)).not.toContain('- skill-1:')
    expect(textOf(res.body)).toContain('- skill-2:')
  })
})
