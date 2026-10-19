import { describe, it, expect } from 'vitest'
import { ModuleManager } from '../../src/modules/registry.js'
import type { GatewayModule, GatewayModuleContext, ModuleTransformResult, ModuleStats } from '../../src/modules/types.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { applyHotReload } from '../../src/config/hotReload.js'
import type { Config } from '../../src/types.js'
import { PayloadModule, type PayloadOutcome } from '../../src/modules/base.js'
import { Screening } from '../../src/modules/screening.js'
import { ToolResultShuntModule } from '../../src/modules/builtin/toolResultShunt.js'
import { StoredOriginals } from '../../src/modules/shuntStore.js'

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

// Slice S6 of the tool result shunt: the pass that runs after detection and DLP
// (specs/001-tool-result-shunt, FR-007, FR-012). A module marked `afterScreening`
// sees ctx.screening and ctx.remoteAddress; transformRequest leaves it alone and
// transformScreened runs nothing else.
describe('ModuleManager — the post-screening pass (FR-007, FR-012)', () => {
  const screening = new Screening()
  const ctx: GatewayModuleContext = {
    target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null,
    headers: { 'x-api-key': 'k' },
    screening,
    remoteAddress: '127.0.0.1',
  }
  const stats = () => new DummyUppercaseModule().getStats()

  /** A plain module marked afterScreening: it appends `mark` to the body and remembers the context it was given. */
  class AfterModule implements GatewayModule {
    readonly name: string
    readonly description = 'runs after screening'
    readonly afterScreening = true
    enabled = true
    invocations = 0
    seen: GatewayModuleContext | undefined
    constructor(readonly id: string, private readonly mark = '!') { this.name = id }
    transformRequest(body: string, c: GatewayModuleContext): ModuleTransformResult {
      this.invocations++
      this.seen = c
      return { body: body + this.mark, modified: true }
    }
    getStats(): ModuleStats { return stats() }
  }

  /** A payload module marked afterScreening, with an asynchronous prepare step. */
  class ScreenedPayloadModule extends PayloadModule<{ enabled: boolean }> {
    readonly id = 'screened-payload'
    readonly name = 'Screened Payload'
    readonly description = 'a payload module that runs after screening'
    readonly afterScreening = true
    prepared = false
    prepareCtx: GatewayModuleContext | undefined
    applyCtx: GatewayModuleContext | undefined
    constructor() { super({ enabled: true }) }
    override async prepare(payload: Record<string, unknown>, c: GatewayModuleContext): Promise<void> {
      this.prepareCtx = c
      await new Promise(resolve => setTimeout(resolve, 5))
      this.prepared = true
      payload.prepared = true
    }
    protected apply(payload: Record<string, unknown>, c: GatewayModuleContext): PayloadOutcome {
      this.applyCtx = c
      // True only when the manager awaited prepare before it called this.
      payload.appliedAfterPrepare = this.prepared
      return { changed: true, tokensOriginal: 100, tokensPruned: 40 }
    }
  }

  /** A module marked afterScreening whose pass fails: the manager must carry on without it. */
  const failing = (kind: 'throws' | 'rejects'): GatewayModule => ({
    id: kind, name: kind, description: kind, enabled: true, afterScreening: true,
    transformRequest: () => { if (kind === 'throws') throw new Error('module bug'); return Promise.reject(new Error('async module bug')) },
    getStats: stats,
  })

  it('transformRequest skips a module marked afterScreening', async () => {
    const mgr = new ModuleManager(undefined, false)
    const after = new AfterModule('after')
    mgr.register(after)
    const res = await mgr.transformRequest('hello', ctx)
    expect(res).toMatchObject({ body: 'hello', modified: false })
    expect(after.invocations).toBe(0)
  })

  it('transformRequest still runs the modules that are not marked', async () => {
    const mgr = new ModuleManager(undefined, false)
    const plain = new DummyUppercaseModule()
    const after = new AfterModule('after')
    mgr.register(plain)
    mgr.register(after)
    const res = await mgr.transformRequest('hello', ctx)
    expect(res.body).toBe('HELLO')
    expect(plain.invocations).toBe(1)
    expect(after.invocations).toBe(0)
  })

  it('transformScreened runs the modules marked afterScreening and no other', async () => {
    const mgr = new ModuleManager(undefined, false)
    const plain = new DummyUppercaseModule()
    const after = new AfterModule('after')
    mgr.register(plain)
    mgr.register(after)
    const res = await mgr.transformScreened('hello', ctx)
    expect(res).toMatchObject({ body: 'hello!', modified: true })
    expect(after.invocations).toBe(1)
    expect(plain.invocations).toBe(0)
  })

  it('transformScreened skips a disabled module', async () => {
    const mgr = new ModuleManager(undefined, false)
    const after = new AfterModule('after')
    after.enabled = false
    mgr.register(after)
    const res = await mgr.transformScreened('hello', ctx)
    expect(res).toMatchObject({ body: 'hello', modified: false, events: [] })
    expect(after.invocations).toBe(0)
  })

  it('transformScreened with nothing marked returns the body unchanged', async () => {
    const mgr = new ModuleManager(undefined, false)
    mgr.register(new DummyUppercaseModule())
    expect(await mgr.transformScreened('hello', ctx)).toMatchObject({ body: 'hello', modified: false, events: [] })
  })

  it('transformScreened runs the marked modules in registration order, each on the body the one before left', async () => {
    const mgr = new ModuleManager(undefined, false)
    mgr.register(new AfterModule('first', 'A'))
    mgr.register(new AfterModule('second', 'B'))
    expect((await mgr.transformScreened('hello', ctx)).body).toBe('helloAB')
  })

  it('transformScreened passes ctx.screening and ctx.remoteAddress through to a plain module', async () => {
    const mgr = new ModuleManager(undefined, false)
    const after = new AfterModule('after')
    mgr.register(after)
    await mgr.transformScreened('hello', ctx)
    expect(after.seen?.screening).toBe(screening)
    expect(after.seen?.remoteAddress).toBe('127.0.0.1')
  })

  it('transformScreened awaits prepare, hands the context to prepare and apply, and returns the rewritten body and its events', async () => {
    const mgr = new ModuleManager(undefined, false)
    const mod = new ScreenedPayloadModule()
    mgr.register(mod)
    const res = await mgr.transformScreened(JSON.stringify({ messages: [] }), ctx)
    expect(res.modified).toBe(true)
    expect(JSON.parse(res.body)).toEqual({ messages: [], prepared: true, appliedAfterPrepare: true })
    expect(mod.prepareCtx?.screening).toBe(screening)
    expect(mod.prepareCtx?.remoteAddress).toBe('127.0.0.1')
    expect(mod.applyCtx?.screening).toBe(screening)
    expect(mod.applyCtx?.remoteAddress).toBe('127.0.0.1')
    expect(res.events.map(e => e.moduleId)).toEqual(['screened-payload'])
  })

  it('transformRequest does not run a payload module marked afterScreening, prepare included', async () => {
    const mgr = new ModuleManager(undefined, false)
    const mod = new ScreenedPayloadModule()
    mgr.register(mod)
    const body = JSON.stringify({ messages: [] })
    expect(await mgr.transformRequest(body, ctx)).toMatchObject({ body, modified: false })
    expect(mod.prepareCtx).toBeUndefined()
    expect(mod.applyCtx).toBeUndefined()
  })

  it.each(['throws', 'rejects'] as const)('transformScreened fails open when a module %s: the others still run on the last good body (FR-007)', async kind => {
    const mgr = new ModuleManager(undefined, false)
    mgr.register(new AfterModule('before', 'A'))
    mgr.register(failing(kind))
    const last = new AfterModule('last', 'Z')
    mgr.register(last)
    const res = await mgr.transformScreened('hello', ctx)
    expect(res).toMatchObject({ body: 'helloAZ', modified: true })
    expect(last.invocations).toBe(1)
  })

  it('transformScreened fails open when a module throws and nothing else changed the body (FR-007)', async () => {
    const mgr = new ModuleManager(undefined, false)
    mgr.register(failing('throws'))
    expect(await mgr.transformScreened('hello', ctx)).toMatchObject({ body: 'hello', modified: false, events: [] })
  })

  it('transformScreened fails open when prepare rejects: the request is forwarded as it was (FR-007)', async () => {
    const mgr = new ModuleManager(undefined, false)
    const mod = new ScreenedPayloadModule()
    mod.prepare = () => Promise.reject(new Error('worker down'))
    mgr.register(mod)
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    expect(await mgr.transformScreened(body, ctx)).toMatchObject({ body, modified: false, events: [] })
  })

  describe('the tool result shunt module (FR-012)', () => {
    it('runs after screening and keeps its stored originals in a StoredOriginals', () => {
      const mod = new ToolResultShuntModule()
      expect(mod.afterScreening).toBe(true)
      expect(mod.store).toBeInstanceOf(StoredOriginals)
      expect(mod.store).toBe(mod.store)
    })

    it('is registered with the flag, so the registry runs it in the pass and not in transformRequest', () => {
      expect(new ModuleManager().getModule('tool-result-shunt')?.afterScreening).toBe(true)
    })
  })
})
