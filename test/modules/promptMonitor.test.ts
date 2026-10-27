import { describe, it, expect } from 'vitest'
import { PromptMonitorModule } from '../../src/modules/builtin/promptMonitor.js'
import { ModuleManager } from '../../src/modules/registry.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import type { Config, PromptMonitorConfig } from '../../src/types.js'

const ctx = (over: Partial<GatewayModuleContext> = {}): GatewayModuleContext =>
  ({ target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null, sessionKey: '10.0.0.1', ...over })
const cfg = (over: Partial<PromptMonitorConfig> = {}): PromptMonitorConfig => ({ enabled: true, maxEntries: 500, maxChars: 4000, ...over })
const anthropic = (messages: unknown[], model = 'claude-opus-5-5') => JSON.stringify({ model, messages })
const run = (mod: PromptMonitorModule, body: string, c = ctx()) => mod.transformRequest(body, c)

describe('PromptMonitorModule', () => {
  it('records the newest user prompt and changes nothing', () => {
    const mod = new PromptMonitorModule(cfg())
    const body = anthropic([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: 'second question' },
    ])
    const result = run(mod, body)
    expect(result).toEqual({ body, modified: false })
    const { entries, total } = mod.query({})
    expect(total).toBe(1)
    expect(entries[0]).toMatchObject({ text: 'second question', target: 'api.anthropic.com', model: 'claude-opus-5-5', session: '10.0.0.1' })
  })

  it('does not record assistant text, tool results or system text as prompts', () => {
    const mod = new PromptMonitorModule(cfg())
    run(mod, JSON.stringify({
      model: 'm',
      system: 'you are helpful',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] },
      ],
    }))
    expect(mod.query({}).total).toBe(0)
  })

  it('records a prompt once while an agent resends it after each tool result', () => {
    const mod = new PromptMonitorModule(cfg())
    const ask = { role: 'user', content: 'fix the build' }
    run(mod, anthropic([ask]))
    run(mod, anthropic([ask, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }]))
    expect(mod.query({}).total).toBe(1)
    run(mod, anthropic([{ role: 'user', content: 'now the tests' }]))
    expect(mod.query({}).total).toBe(2)
  })

  it('skips a system-reminder part appended to the user turn', () => {
    const mod = new PromptMonitorModule(cfg())
    run(mod, anthropic([{ role: 'user', content: [{ type: 'text', text: 'the real prompt' }, { type: 'text', text: '<system-reminder>noise</system-reminder>' }] }]))
    expect(mod.query({}).entries[0]!.text).toBe('the real prompt')
  })

  it('reads OpenAI chat, Responses and Gemini shapes', () => {
    const mod = new PromptMonitorModule(cfg())
    run(mod, JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'chat prompt' }] }), ctx({ target: 'api.openai.com', path: '/v1/chat/completions' }))
    run(mod, JSON.stringify({ model: 'gpt-x', input: 'responses prompt' }), ctx({ target: 'api.openai.com', path: '/v1/responses' }))
    run(mod, JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'gemini prompt' }] }] }), ctx({ target: 'generativelanguage.googleapis.com', path: '/v1beta/models/g:generateContent' }))
    expect(mod.query({}).entries.map(e => e.text).sort()).toEqual(['chat prompt', 'gemini prompt', 'responses prompt'])
  })

  it('redacts secrets before storing, whatever the DLP mode', () => {
    const mod = new PromptMonitorModule(cfg())
    run(mod, anthropic([{ role: 'user', content: 'deploy with AKIAJ5Q2WZ7RT3MN4XPB please' }]))
    const text = mod.query({}).entries[0]!.text
    expect(text).not.toContain('AKIAJ5Q2WZ7RT3MN4XPB')
    expect(text).toContain('deploy with')
  })

  it('truncates long prompts and keeps their full length', () => {
    const mod = new PromptMonitorModule(cfg({ maxChars: 50 }))
    run(mod, anthropic([{ role: 'user', content: 'x'.repeat(500) }]))
    const e = mod.query({}).entries[0]!
    expect(e.text.length).toBeLessThanOrEqual(50)
    expect(e.chars).toBe(500)
    expect(e.truncated).toBe(true)
  })

  it('keeps only the newest maxEntries', () => {
    const mod = new PromptMonitorModule(cfg({ maxEntries: 3 }))
    for (let i = 0; i < 5; i++) run(mod, anthropic([{ role: 'user', content: `prompt ${i}` }]))
    expect(mod.query({}).entries.map(e => e.text)).toEqual(['prompt 4', 'prompt 3', 'prompt 2'])
  })

  it('does not record non-LLM requests or non-JSON bodies', () => {
    const mod = new PromptMonitorModule(cfg())
    run(mod, anthropic([{ role: 'user', content: 'hi' }]), ctx({ isLlmRequest: false }))
    run(mod, 'not json')
    expect(mod.query({}).total).toBe(0)
  })

  describe('search and filters', () => {
    const seeded = () => {
      const mod = new PromptMonitorModule(cfg())
      run(mod, anthropic([{ role: 'user', content: 'Refactor the Parser module' }]), ctx({ sessionKey: 'a' }))
      run(mod, anthropic([{ role: 'user', content: 'write a haiku about parsers' }], 'claude-haiku-5-5'), ctx({ sessionKey: 'b' }))
      run(mod, JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'unrelated question' }] }), ctx({ target: 'api.openai.com', sessionKey: 'a' }))
      return mod
    }

    it('matches every search term, case-insensitively', () => {
      const mod = seeded()
      expect(mod.query({ q: 'PARSER' }).entries.map(e => e.text)).toEqual(['write a haiku about parsers', 'Refactor the Parser module'])
      expect(mod.query({ q: 'parser module' }).entries.map(e => e.text)).toEqual(['Refactor the Parser module'])
      expect(mod.query({ q: 'nothing like this' }).total).toBe(0)
    })

    it('filters by target, model and session, and combines them with a search', () => {
      const mod = seeded()
      expect(mod.query({ target: 'api.openai.com' }).total).toBe(1)
      expect(mod.query({ model: 'claude-haiku-5-5' }).total).toBe(1)
      expect(mod.query({ session: 'a' }).total).toBe(2)
      expect(mod.query({ session: 'a', q: 'parser' }).total).toBe(1)
    })

    it('filters by time and pages the result', () => {
      const mod = seeded()
      const all = mod.query({}).entries
      expect(mod.query({ since: '2999-01-01T00:00:00Z' }).total).toBe(0)
      expect(mod.query({ until: '1999-01-01T00:00:00Z' }).total).toBe(0)
      expect(mod.query({ since: '1999-01-01T00:00:00Z' }).total).toBe(3)
      const page = mod.query({ limit: 1, offset: 1 })
      expect(page.total).toBe(3)
      expect(page.entries).toEqual([all[1]])
    })

    it('lists the values a filter can take', () => {
      const f = seeded().query({}).facets
      expect(f.targets.sort()).toEqual(['api.anthropic.com', 'api.openai.com'])
      expect(f.models.sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'gpt-x'])
      expect(f.sessions.sort()).toEqual(['a', 'b'])
    })
  })

  describe('opt in and out in a live session', () => {
    it('stops recording and forgets what it held when switched off', () => {
      const live = structuredClone(DEFAULT_CONFIG) as Config
      const mgr = new ModuleManager(live)
      const mod = mgr.getModule('prompt-monitor') as PromptMonitorModule
      expect(mod.enabled).toBe(false)

      void run(mod, anthropic([{ role: 'user', content: 'ignored while off' }]))
      expect(mod.query({}).total).toBe(0)

      mgr.setModuleEnabled('prompt-monitor', true)
      void run(mod, anthropic([{ role: 'user', content: 'seen while on' }]))
      expect(mod.query({}).total).toBe(1)

      // Hot reload writes the config object, not the module: the monitor must
      // notice the switch itself.
      live.modules!.promptMonitor!.enabled = false
      expect(mod.query({}).total).toBe(0)
      void run(mod, anthropic([{ role: 'user', content: 'ignored again' }]))
      expect(mod.query({}).total).toBe(0)

      mgr.setModuleEnabled('prompt-monitor', true)
      expect(mod.query({}).total).toBe(0)
    })

    it('clear() drops the held prompts but stays on', () => {
      const mod = new PromptMonitorModule(cfg())
      run(mod, anthropic([{ role: 'user', content: 'one' }]))
      mod.clear()
      expect(mod.query({}).total).toBe(0)
      run(mod, anthropic([{ role: 'user', content: 'two' }]))
      expect(mod.query({}).total).toBe(1)
    })
  })

  it('reports its count as a KPI and holds no events', () => {
    const mod = new PromptMonitorModule(cfg())
    run(mod, anthropic([{ role: 'user', content: 'one' }]))
    const stats = mod.getStats()
    expect(stats.id).toBe('prompt-monitor')
    expect(stats.kpis?.find(k => k.key === 'held')?.value).toBe(1)
    expect(stats.recentEvents).toEqual([])
  })
})
