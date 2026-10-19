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
    const filter = { enabled: false, dropTools: ['CronCreate', 'mcp__axiom__*'] }
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

  it('does nothing while off', () => {
    const mod = new ToolUsageModule({ enabled: false })
    mod.transformRequest(JSON.stringify({ tools: offered, messages: [] }), ctx)
    expect(kpi(mod, 'requests')).toBe(0)
  })
})
