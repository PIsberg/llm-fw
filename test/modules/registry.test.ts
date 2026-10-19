import { describe, it, expect } from 'vitest'
import { ModuleManager } from '../../src/modules/registry.js'
import type { GatewayModule, GatewayModuleContext, ModuleTransformResult, ModuleStats } from '../../src/modules/types.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { applyHotReload } from '../../src/config/hotReload.js'
import type { Config } from '../../src/types.js'

class DummyUppercaseModule implements GatewayModule {
  readonly id = 'dummy-uppercase'
  readonly name = 'Dummy Uppercase'
  readonly description = 'Converts text to uppercase'
  enabled = true
  invocations = 0

  transformRequest(body: string, ctx: GatewayModuleContext): ModuleTransformResult {
    this.invocations++
    return {
      body: body.toUpperCase(),
      modified: true,
      metadata: { upper: true },
    }
  }

  getStats(): ModuleStats {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      totalInvocations: this.invocations,
      tokensOriginal: 10,
      tokensPruned: 8,
      tokensSaved: 2,
      percentSaved: 20,
      recentEvents: [],
    }
  }
}

describe('ModuleManager', () => {
  const dummyCtx: GatewayModuleContext = {
    target: 'api.openai.com',
    method: 'POST',
    path: '/v1/chat/completions',
    isLlmRequest: true,
    parser: null,
  }

  it('registers and retrieves modules', () => {
    const mgr = new ModuleManager(undefined, false)
    const mod = new DummyUppercaseModule()
    mgr.register(mod)

    expect(mgr.getModule('dummy-uppercase')).toBe(mod)
    expect(mgr.listModules()).toHaveLength(1)
    expect(mgr.listModules()[0]?.id).toBe('dummy-uppercase')
  })

  // #411: a module can ask for a request header on the upstream call (the
  // context-management beta). The manager merges what each module asks for
  // and lets the modules after it see the request as it will be sent.
  it('carries the headers modules ask for, and shows them to the next module', async () => {
    const seen: Array<Record<string, string | string[] | undefined> | undefined> = []
    const stub = (id: string, headers?: Record<string, string>): GatewayModule => ({
      id, name: id, description: '', enabled: true,
      transformRequest(body: string, ctx: GatewayModuleContext): ModuleTransformResult {
        seen.push(ctx.headers)
        return headers ? { body, modified: true, headers } : { body, modified: false }
      },
      getStats: () => ({ id, name: id, enabled: true, totalInvocations: 0, tokensOriginal: 0, tokensPruned: 0, tokensSaved: 0, percentSaved: 0, recentEvents: [] }),
    })
    const mgr = new ModuleManager(undefined, false)
    mgr.register(stub('a', { 'anthropic-beta': 'one' }))
    mgr.register(stub('b'))
    mgr.register(stub('c', { 'anthropic-beta': 'one,two', 'x-extra': 'yes' }))
    const original = { 'anthropic-version': '2023-06-01' }
    const ctx = { ...dummyCtx, headers: original }
    const res = await mgr.transformRequest('{}', ctx)
    expect(res.headers).toEqual({ 'anthropic-beta': 'one,two', 'x-extra': 'yes' })
    expect(seen[1]).toEqual({ 'anthropic-version': '2023-06-01', 'anthropic-beta': 'one' })
    // The context carries the request as it will be sent, for respond() and
    // the modules after; the caller's own header object is never written to.
    expect(ctx.headers).toEqual({ 'anthropic-version': '2023-06-01', 'anthropic-beta': 'one,two', 'x-extra': 'yes' })
    expect(original).toEqual({ 'anthropic-version': '2023-06-01' })

    const none = await mgr.transformRequest('{}', dummyCtx)
    expect(none.headers).toEqual({ 'anthropic-beta': 'one,two', 'x-extra': 'yes' })
    await expect(new ModuleManager(undefined, false).transformRequest('{}', dummyCtx)).resolves.toMatchObject({ headers: {} })
  })

  it('registers token-pruner by default', () => {
    const mgr = new ModuleManager()
    expect(mgr.getModule('token-pruner')).toBeDefined()
  })

  it('runs transformRequest across active modules', async () => {
    const mgr = new ModuleManager()
    const mod = new DummyUppercaseModule()
    mgr.register(mod)

    const res = await mgr.transformRequest('hello world', dummyCtx)
    expect(res.modified).toBe(true)
    expect(res.body).toBe('HELLO WORLD')
    expect(mod.invocations).toBe(1)
  })

  it('skips disabled modules during transformRequest', async () => {
    const mgr = new ModuleManager()
    const mod = new DummyUppercaseModule()
    mod.enabled = false
    mgr.register(mod)

    const res = await mgr.transformRequest('hello world', dummyCtx)
    expect(res.modified).toBe(false)
    expect(res.body).toBe('hello world')
    expect(mod.invocations).toBe(0)
  })

  it('allows dynamic runtime enablement toggle', async () => {
    const mgr = new ModuleManager()
    const mod = new DummyUppercaseModule()
    mgr.register(mod)

    mgr.setModuleEnabled('dummy-uppercase', false)
    expect(mod.enabled).toBe(false)

    const res1 = await mgr.transformRequest('test', dummyCtx)
    expect(res1.modified).toBe(false)

    mgr.setModuleEnabled('dummy-uppercase', true)
    expect(mod.enabled).toBe(true)

    const res2 = await mgr.transformRequest('test', dummyCtx)
    expect(res2.modified).toBe(true)
    expect(res2.body).toBe('TEST')
  })

  it('aggregates summary metrics across all registered modules', () => {
    const mgr = new ModuleManager()
    const mod = new DummyUppercaseModule()
    mgr.register(mod)

    const summary = mgr.getSummaryStats()
    expect(summary.totalTokensSaved).toBe(2)
    expect(summary.totalTokensOriginal).toBe(10)
    expect(summary.overallPercentSaved).toBe(20)
  })

  it('fails open when a module throws: the request keeps the last good body', async () => {
    const mgr = new ModuleManager(undefined, false)
    const upper = new DummyUppercaseModule()
    mgr.register(upper)
    mgr.register({
      id: 'broken', name: 'Broken', description: 'throws', enabled: true,
      transformRequest: () => { throw new Error('module bug') },
      getStats: () => upper.getStats(),
    })
    const after = new DummyUppercaseModule()
    Object.defineProperty(after, 'id', { value: 'after' })
    mgr.register(after)

    const res = await mgr.transformRequest('hello', dummyCtx)
    expect(res.body).toBe('HELLO')
    expect(res.modified).toBe(true)
    expect(after.invocations).toBe(1)
  })

  it('fails open when an async module rejects', async () => {
    const mgr = new ModuleManager(undefined, false)
    mgr.register({
      id: 'rejects', name: 'Rejects', description: 'rejects', enabled: true,
      transformRequest: () => Promise.reject(new Error('async module bug')),
      getStats: () => new DummyUppercaseModule().getStats(),
    })
    const res = await mgr.transformRequest('hello', dummyCtx)
    expect(res).toMatchObject({ body: 'hello', modified: false })
  })

  it('marks events as not applied on a dry run (observe mode)', async () => {
    const config = structuredClone(DEFAULT_CONFIG) as Config
    config.modules!.tokenPruner.enabled = true
    const mgr = new ModuleManager(config)
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'a     b' }] })

    const dry = await mgr.transformRequest(body, { ...dummyCtx, dryRun: true })
    expect(dry.events[0]?.applied).toBe(false)
    const wet = await mgr.transformRequest(body, dummyCtx)
    expect(wet.events[0]?.applied).toBe(true)
  })

  it('a hot-reloaded tokenPruner.enabled reaches the running module', async () => {
    const live = structuredClone(DEFAULT_CONFIG) as Config
    live.modules!.tokenPruner.enabled = false
    const mgr = new ModuleManager(live)
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'a     b' }] })
    expect((await mgr.transformRequest(body, dummyCtx)).modified).toBe(false)

    const incoming = structuredClone(live)
    incoming.modules!.tokenPruner.enabled = true
    applyHotReload(live, incoming, () => {})

    expect((await mgr.transformRequest(body, dummyCtx)).modified).toBe(true)
  })
})

describe('ModuleManager — one parse per request', () => {
  const dummyCtx: GatewayModuleContext = {
    target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null,
    headers: { 'x-api-key': 'k' },
  }

  it('gives the same body as running every module on its own', async () => {
    const live = structuredClone(DEFAULT_CONFIG) as Config
    const mods = live.modules as unknown as Record<string, { enabled: boolean }>
    for (const key of Object.keys(mods)) if (key !== 'enabled') mods[key]!.enabled = true
    const file = '     1\texport const x  =  1   \n'.repeat(300)
    const body = JSON.stringify({
      system: 'Be   brief.',
      tools: [{ name: 't', description: 'Runs   things.\n\n\n\nCarefully.', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'Read   it \u001b[1mnow\u001b[0m' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: file }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: file }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: '{\n  "ok": true\n}\n' + 'retry\n'.repeat(5) + '10%\r50%\r100%\n' }] },
      ],
    })
    const chained = await new ModuleManager(live).transformRequest(body, dummyCtx)

    let sequential = body
    for (const mod of new ModuleManager(structuredClone(live)).listModules()) {
      if (!mod.enabled) continue
      const res = await mod.transformRequest(sequential, dummyCtx)
      if (res.modified) sequential = res.body
    }
    expect(chained.modified).toBe(true)
    expect(chained.body).toBe(sequential)
  })
})

describe('token-pruner default', () => {
  it('is opt-in: the built-in config does not rewrite prompts', () => {
    expect(DEFAULT_CONFIG.modules?.enabled).toBe(true)
    expect(DEFAULT_CONFIG.modules?.tokenPruner.enabled).toBe(false)
  })
})
