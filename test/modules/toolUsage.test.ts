import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolUsageModule } from '../../src/modules/builtin/toolUsage.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }

const tool = (name: string, size = 1) => ({ name, description: 'x '.repeat(40 * size), input_schema: { type: 'object', properties: {} } })
const usage = () => new ToolUsageModule({ enabled: true })
const kpi = (mod: ToolUsageModule, key: string) => mod.getStats().kpis!.find(k => k.key === key)!.value
const sse = (...events: unknown[]) => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: Buffer.from(events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')),
})

describe('ToolUsageModule', () => {
  const offered = [tool('Bash'), tool('Read'), tool('NotebookEdit', 5), tool('CronCreate', 2)]

  it('never changes the request', () => {
    const body = JSON.stringify({ tools: offered, messages: [{ role: 'user', content: 'hi' }] })
    const res = usage().transformRequest(body, ctx)
    expect(res.modified).toBe(false)
    expect(res.body).toBe(body)
  })

  it('lists the offered tools no request or response has called, largest first', () => {
    const mod = usage()
    mod.transformRequest(JSON.stringify({
      tools: offered,
      messages: [
        { role: 'user', content: 'run it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
      ],
    }), ctx)
    expect(kpi(mod, 'offered')).toBe(4)
    expect(kpi(mod, 'called')).toBe(1)
    expect(kpi(mod, 'never')).toBe(3)
    const detail = mod.getStats().detail!
    expect(detail.indexOf('NotebookEdit')).toBeLessThan(detail.indexOf('CronCreate'))
    expect(detail.indexOf('CronCreate')).toBeLessThan(detail.indexOf('Read'))
    expect(detail).not.toContain('Bash')
    expect(Number(String(kpi(mod, 'neverTokens')).replace(/,/g, ''))).toBeGreaterThan(0)
  })

  // Through the proxy, Claude Code continues a server-side thread: the request
  // carries the tool results, and only the response names the call.
  it('learns calls from a streamed response', () => {
    const mod = usage()
    mod.transformRequest(JSON.stringify({ tools: offered, messages: [{ role: 'user', content: 'hi' }] }), ctx)
    mod.observeResponse('{}', ctx, sse(
      { type: 'message_start', message: { id: 'm1', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c9', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a"}' } },
    ))
    expect(kpi(mod, 'called')).toBe(1)
    expect(mod.getStats().detail).not.toContain('Read')
  })

  it('counts a call resent in every request of a growing history once', () => {
    const mod = usage()
    const history = [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ]
    for (let i = 0; i < 3; i++) mod.transformRequest(JSON.stringify({ tools: offered, messages: history }), ctx)
    expect(kpi(mod, 'calls')).toBe(1)
    expect(kpi(mod, 'requests')).toBe(3)
  })

  it('reads OpenAI chat and Gemini tool lists and calls', () => {
    const mod = usage()
    mod.transformRequest(JSON.stringify({
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }, { type: 'function', function: { name: 'unused', parameters: {} } }],
      messages: [{ role: 'assistant', tool_calls: [{ id: 'k1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }],
    }), { ...ctx, path: '/v1/chat/completions' })
    mod.transformRequest(JSON.stringify({
      tools: [{ functionDeclarations: [{ name: 'g_used' }, { name: 'g_unused' }] }],
      contents: [{ role: 'model', parts: [{ functionCall: { name: 'g_used', args: {} } }] }],
    }), ctx)
    const detail = mod.getStats().detail!
    expect(detail).toContain('unused')
    expect(detail).toContain('g_unused')
    expect(detail).not.toContain('lookup')
    expect(detail).not.toContain('g_used')
  })

  // A restart started the list from nothing, so it never held enough evidence
  // to name a tool in the Tool Filter. With persistTo, a later process carries on.
  describe('persistence', () => {
    let dir: string
    beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-tool-usage-')) })
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

    it('a later process sees what an earlier one recorded', () => {
      const file = join(dir, 'tool-usage.json')
      const first = usage()
      first.persistTo(file)
      first.transformRequest(JSON.stringify({
        tools: offered,
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }] }],
      }), ctx)
      first.flush()

      const second = usage()
      second.persistTo(file)
      expect(kpi(second, 'requests')).toBe(1)
      expect(kpi(second, 'offered')).toBe(4)
      expect(kpi(second, 'called')).toBe(1)
      expect(second.getStats().detail).toContain('NotebookEdit')
      expect(second.getStats().detail).not.toContain('Bash')
    })

    it('starts empty on a missing or unreadable file, and writes nothing without persistTo', () => {
      const file = join(dir, 'tool-usage.json')
      fs.writeFileSync(file, '{not json')
      const mod = usage()
      mod.persistTo(file)
      expect(kpi(mod, 'requests')).toBe(0)

      const unbound = usage()
      unbound.transformRequest(JSON.stringify({ tools: offered, messages: [] }), ctx)
      unbound.flush()
      expect(fs.readdirSync(dir)).toEqual(['tool-usage.json'])
      expect(fs.readFileSync(file, 'utf8')).toBe('{not json')
    })
  })

  // #407: applying the list meant copying names into toolFilter.dropTools by
  // hand. The card now offers a one-click action, once enough calls have
  // been seen to trust the list, naming only the tools the filter does not
  // already cover, with the filter's full new list.
  it('offers to drop the never-called tools in the Tool Filter once a thousand calls say so', () => {
    const filter = { enabled: false, dropTools: ['CronCreate', 'mcp__axiom__*'], shortenTools: [] as string[], shortenTo: 200, dropSkills: [] as string[] }
    const mod = new ToolUsageModule({ enabled: true }, () => filter)
    const tools = [...offered, tool('mcp__axiom__axiom_query_symbol', 3)]
    const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name: 'Bash', input: {} }] }))
    mod.transformRequest(JSON.stringify({ tools, messages: [{ role: 'user', content: 'hi' }, ...calls(999)] }), ctx)
    expect(mod.getStats().action).toBeUndefined()
    expect(mod.getStats().detail).toContain('1,000 calls')

    mod.transformRequest(JSON.stringify({ tools, messages: [{ role: 'user', content: 'hi' }, ...calls(1000)] }), ctx)
    expect(mod.getStats().action).toEqual({
      label: 'Drop these 2 tools in the Tool Filter',
      module: 'tool-filter',
      enabled: true,
      options: { dropTools: ['CronCreate', 'mcp__axiom__*', 'NotebookEdit', 'Read'] },
    })

    // Once the filter has them, nothing is left to offer.
    filter.dropTools = ['CronCreate', 'mcp__axiom__*', 'NotebookEdit', 'Read']
    expect(mod.getStats().action).toBeUndefined()
    // Without a filter to write to, none either.
    expect(new ToolUsageModule({ enabled: true }).getStats().action).toBeUndefined()
  })

  // A tool called now and then cannot be dropped, and the largest definition
  // on one developer's requests (8,167 tokens) was one called in 0.3% of
  // sessions. Those are offered to the Tool Filter's shortenTools instead,
  // but only where the stub saves more than the cache rewrite each first
  // call costs: a tool called under once in 200 calls lost money as a stub.
  describe('rarely called tools', () => {
    const tools = [tool('Bash'), tool('Read'), tool('Artifact', 800), tool('Sometimes', 800), tool('Tiny'), tool('NotebookEdit', 5)]
    const call = (name: string, n: number) => Array.from({ length: n }, (_, i) => ({ role: 'assistant', content: [{ type: 'tool_use', id: `${name}${i}`, name, input: {} }] }))
    const history = (bash: number) => JSON.stringify({ tools, messages: [{ role: 'user', content: 'hi' }, ...call('Bash', bash), ...call('Read', 100), ...call('Artifact', 2), ...call('Sometimes', 30), ...call('Tiny', 1)] })

    it('offers to shorten a large tool whose calls are few enough for the stub to pay, beside the drop', () => {
      const filter = { enabled: false, dropTools: [] as string[], shortenTools: [] as string[], shortenTo: 200, dropSkills: [] as string[] }
      const mod = new ToolUsageModule({ enabled: true }, () => filter)
      mod.transformRequest(history(800), ctx)
      expect(mod.getStats().action).toBeUndefined()

      mod.transformRequest(history(6000), ctx)
      const stats = mod.getStats()
      // Tiny is as rare, but a stub of it saves nothing; Sometimes is as
      // large, but its 30 first calls cost more than its stub saves.
      expect(stats.action).toEqual({
        label: 'Drop 1 never-called and shorten 1 rarely called tools in the Tool Filter',
        module: 'tool-filter',
        enabled: true,
        options: { dropTools: ['NotebookEdit'], shortenTools: ['Artifact'] },
      })
      expect(stats.detail).toMatch(/Rarely called[^.]*Artifact \([\d,]+ tokens, 2 calls\)/)
      expect(stats.detail).not.toMatch(/Rarely called[^.]*(Tiny|Read|Bash|Sometimes)/)

      filter.dropTools = ['NotebookEdit']
      expect(mod.getStats().action).toEqual({
        label: 'Shorten these 1 rarely called tools in the Tool Filter',
        module: 'tool-filter',
        enabled: true,
        options: { shortenTools: ['Artifact'] },
      })

      // Named already, by either list: nothing left to offer.
      filter.shortenTools = ['Art*']
      expect(mod.getStats().action).toBeUndefined()
      filter.shortenTools = []
      filter.dropTools = ['NotebookEdit', 'Artifact']
      expect(mod.getStats().action).toBeUndefined()
    })

    // A deferred tool is on the list of the few requests after it was
    // loaded, so its stub is sent on few calls and saves little.
    it('counts a stub as saving only on the requests that offered the tool', () => {
      const filter = { enabled: false, dropTools: ['NotebookEdit'], shortenTools: [] as string[], shortenTo: 200, dropSkills: [] as string[] }
      const mod = new ToolUsageModule({ enabled: true }, () => filter)
      mod.transformRequest(history(6000), ctx)
      expect(mod.getStats().action?.options).toEqual({ shortenTools: ['Artifact'] })
      const without = JSON.stringify({ tools: tools.filter(t => t.name !== 'Artifact'), messages: [{ role: 'user', content: 'hi' }] })
      for (let i = 0; i < 9; i++) mod.transformRequest(without, ctx)
      expect(mod.getStats().action).toBeUndefined()
    })

    it('keeps the count of each tool across a restart', () => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-tool-usage-'))
      try {
        const file = join(dir, 'tool-usage.json')
        const first = usage()
        first.persistTo(file)
        first.transformRequest(history(6000), ctx)
        first.flush()

        const filter = { enabled: false, dropTools: ['NotebookEdit'], shortenTools: [] as string[], shortenTo: 200, dropSkills: [] as string[] }
        const second = new ToolUsageModule({ enabled: true }, () => filter)
        second.persistTo(file)
        expect(second.getStats().action?.options).toEqual({ shortenTools: ['Artifact'] })
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    // A file written before the counts existed says only that a tool was
    // called, not how often: no evidence that it is rare.
    it('offers nothing to shorten from a file that has no counts', () => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-tool-usage-'))
      try {
        const file = join(dir, 'tool-usage.json')
        fs.writeFileSync(file, JSON.stringify({ requests: 10, calls: 5000, offered: { Bash: 800, Artifact: 8167 }, called: ['Bash', 'Artifact'] }))
        const filter = { enabled: false, dropTools: [] as string[], shortenTools: [] as string[], shortenTo: 200, dropSkills: [] as string[] }
        const mod = new ToolUsageModule({ enabled: true }, () => filter)
        mod.persistTo(file)
        expect(kpi(mod, 'called')).toBe(2)
        expect(mod.getStats().action).toBeUndefined()
        expect(mod.getStats().detail ?? '').not.toContain('Rarely called')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  // Claude Code's skill listing is read back on every call like the tool
  // list: 30 of the 93 skills one developer had listed were invoked in 30
  // days. The card names the rest for the Tool Filter's dropSkills.
  describe('skills', () => {
    const listing = [
      'The following skills are available for use with the Skill tool:',
      '',
      '- deslop: Remove AI writing patterns from prose.',
      `- claude-api: Reference for the Claude API.\nTRIGGER - ${'read this first. '.repeat(30)}`,
      `- speckit-plan: ${'Execute the planning workflow. '.repeat(8)}`,
      '- anthropic-skills:pdf',
      '',
      'Today is Monday.',
    ].join('\n')
    const listed = { role: 'system', content: [{ type: 'text', text: listing }] }
    const invoke = (skill: string, id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] })
    const bash = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'assistant', content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: {} }] }))
    const tools = [tool('Bash'), tool('Skill')]

    it('lists the skills no call has invoked, largest first, with what they cost', () => {
      const mod = usage()
      mod.transformRequest(JSON.stringify({ tools, messages: [listed, invoke('deslop', 's1'), invoke('deslop', 's2')] }), ctx)
      expect(kpi(mod, 'skills')).toBe(4)
      expect(kpi(mod, 'skillsNever')).toBe(3)
      expect(mod.getStats().detail).toMatch(/Skills never invoked, largest first \(tokens per request\): claude-api \(\d+\), speckit-plan \(\d+\), anthropic-skills:pdf \(\d+\)\./)
      expect(mod.getStats().detail).not.toMatch(/Skills never invoked[^.]*deslop/)
    })

    it('learns an invocation from a streamed response, and one written with a slash', () => {
      const mod = usage()
      mod.transformRequest(JSON.stringify({ tools, messages: [listed, invoke('/claude-api', 's1')] }), ctx)
      mod.observeResponse('{}', ctx, sse(
        { type: 'message_start', message: { id: 'm1', content: [] } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 's9', name: 'Skill', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"skill":"specki' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 't-plan","args":"x"}' } },
      ))
      expect(kpi(mod, 'skillsNever')).toBe(2)
      expect(mod.getStats().detail).toMatch(/Skills never invoked[^.]*: deslop \(\d+\), anthropic-skills:pdf \(\d+\)\./)
    })

    it('offers the never-invoked skills to the Tool Filter once a thousand calls say so', () => {
      const filter = { enabled: false, dropTools: [] as string[], shortenTools: [] as string[], shortenTo: 200, dropSkills: ['anthropic-skills:*'] }
      const mod = new ToolUsageModule({ enabled: true }, () => filter)
      mod.transformRequest(JSON.stringify({ tools, messages: [listed, invoke('deslop', 's1'), ...bash(900)] }), ctx)
      expect(mod.getStats().action).toBeUndefined()
      mod.transformRequest(JSON.stringify({ tools, messages: [listed, invoke('deslop', 's1'), ...bash(1000)] }), ctx)
      expect(mod.getStats().action).toEqual({
        label: 'Drop these 2 never-invoked skills in the Tool Filter',
        module: 'tool-filter',
        enabled: true,
        options: { dropSkills: ['anthropic-skills:*', 'claude-api', 'speckit-plan'] },
      })
      filter.dropSkills = ['anthropic-skills:*', 'claude-api', 'speckit-*']
      expect(mod.getStats().action).toBeUndefined()
    })

    it('puts tools and skills in one action when both have something to drop', () => {
      const filter = { enabled: false, dropTools: [] as string[], shortenTools: [] as string[], shortenTo: 200, dropSkills: [] as string[] }
      const mod = new ToolUsageModule({ enabled: true }, () => filter)
      mod.transformRequest(JSON.stringify({ tools: [...tools, tool('NotebookEdit', 5)], messages: [listed, invoke('deslop', 's1'), invoke('claude-api', 's2'), invoke('speckit-plan', 's3'), ...bash(1000)] }), ctx)
      expect(mod.getStats().action).toEqual({
        label: 'Drop 1 never-called tools and drop 1 never-invoked skills in the Tool Filter',
        module: 'tool-filter',
        enabled: true,
        options: { dropTools: ['NotebookEdit'], dropSkills: ['anthropic-skills:pdf'] },
      })
    })

    it('keeps the skills and their counts across a restart', () => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-tool-usage-'))
      try {
        const file = join(dir, 'tool-usage.json')
        const first = usage()
        first.persistTo(file)
        first.transformRequest(JSON.stringify({ tools, messages: [listed, invoke('deslop', 's1')] }), ctx)
        first.flush()
        const second = usage()
        second.persistTo(file)
        expect(kpi(second, 'skills')).toBe(4)
        expect(kpi(second, 'skillsNever')).toBe(3)
        second.resetStats()
        expect(kpi(second, 'skills')).toBe(0)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('reports nothing about skills for a client that lists none', () => {
      const mod = usage()
      mod.transformRequest(JSON.stringify({ tools, messages: [{ role: 'user', content: 'hi' }] }), ctx)
      expect(kpi(mod, 'skills')).toBe(0)
      expect(mod.getStats().detail ?? '').not.toContain('Skills')
    })
  })

  it('does nothing while off', () => {
    const mod = new ToolUsageModule({ enabled: false })
    mod.transformRequest(JSON.stringify({ tools: offered, messages: [] }), ctx)
    expect(kpi(mod, 'requests')).toBe(0)
  })
})
