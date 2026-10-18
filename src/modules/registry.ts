import type { GatewayModule, GatewayModuleContext, ModuleResponse, ModuleStats } from './types.js'
import type { ModuleEvent, Config, ModulesConfig, ModuleSwitchConfig, HistoryWindowConfig, RepeatCollapseConfig, BlobElideConfig, LeanCtxConfig, ToolResultPrunerConfig, ToolResultDedupConfig, ToolResultTruncateConfig, ToolFilterConfig, CacheControlConfig, ResponseCacheConfig } from '../types.js'
import type { CapturedResponse } from './responseTap.js'
import { HistoryWindowModule } from './builtin/historyWindow.js'
import { AnsiStripModule } from './builtin/ansiStrip.js'
import { ProgressCollapseModule } from './builtin/progressCollapse.js'
import { RepeatCollapseModule } from './builtin/repeatCollapse.js'
import { BlobElideModule } from './builtin/blobElide.js'
import { LeanCtxModule } from './builtin/leanCtx.js'
import { TokenPrunerModule } from './builtin/tokenPruner.js'
import { ToolResultPrunerModule } from './builtin/toolResultPruner.js'
import { ToolResultDedupModule } from './builtin/toolResultDedup.js'
import { ToolResultTruncateModule } from './builtin/toolResultTruncate.js'
import { ToolFilterModule } from './builtin/toolFilter.js'
import { ToolDefinitionPrunerModule } from './builtin/toolDefinitionPruner.js'
import { CacheControlModule } from './builtin/cacheControl.js'
import { ResponseCacheModule } from './builtin/responseCache.js'
import { UsageMeterModule } from './builtin/usageMeter.js'
import { DEFAULT_CONFIG } from '../config/config.js'
import { PayloadModule, parsePayload } from './base.js'
import { createLogger } from '../logger.js'

const log = createLogger('modules')

type BuiltinKey = Exclude<keyof ModulesConfig, 'enabled'>

// Built-in modules in pipeline order, each keyed by the `modules.<key>`
// object that holds its switch and options. The history window runs first,
// so the rest only work on turns that are kept (and dedup never points at a
// dropped one); content cleaners run before the whitespace pruners, so those
// see text without escape codes.
export const BUILTINS: Array<{ key: BuiltinKey; create: (cfg: ModuleSwitchConfig) => GatewayModule }> = [
  { key: 'historyWindow', create: cfg => new HistoryWindowModule(cfg as HistoryWindowConfig) },
  { key: 'ansiStrip', create: cfg => new AnsiStripModule(cfg) },
  { key: 'progressCollapse', create: cfg => new ProgressCollapseModule(cfg) },
  { key: 'repeatCollapse', create: cfg => new RepeatCollapseModule(cfg as RepeatCollapseConfig) },
  { key: 'blobElide', create: cfg => new BlobElideModule(cfg as BlobElideConfig) },
  { key: 'leanCtx', create: cfg => new LeanCtxModule(cfg as LeanCtxConfig) },
  { key: 'tokenPruner', create: cfg => new TokenPrunerModule(cfg) },
  { key: 'toolResultPruner', create: cfg => new ToolResultPrunerModule(cfg as ToolResultPrunerConfig) },
  { key: 'toolResultDedup', create: cfg => new ToolResultDedupModule(cfg as ToolResultDedupConfig) },
  { key: 'toolResultTruncate', create: cfg => new ToolResultTruncateModule(cfg as ToolResultTruncateConfig) },
  { key: 'toolFilter', create: cfg => new ToolFilterModule(cfg as ToolFilterConfig) },
  { key: 'toolDefinitionPruner', create: cfg => new ToolDefinitionPrunerModule(cfg) },
  { key: 'cacheControl', create: cfg => new CacheControlModule(cfg as CacheControlConfig) },
  { key: 'responseCache', create: cfg => new ResponseCacheModule(cfg as ResponseCacheConfig) },
  { key: 'usageMeter', create: cfg => new UsageMeterModule(cfg) },
]

export interface ModulesSummaryStats {
  totalTokensOriginal: number
  totalTokensPruned: number
  totalTokensSaved: number
  overallPercentSaved: number
  // The newest event's flag: false when it was an observe-mode dry run, so
  // the totals are what would have been saved. Absent before any event.
  applied?: boolean
}

export class ModuleManager {
  private modules = new Map<string, GatewayModule>()

  constructor(config?: Config, registerBuiltins = true) {
    if (registerBuiltins) {
      // Hand each module the live config sub-object, creating it from the
      // defaults if a caller's config predates it, so hot reload and the
      // dashboard toggle reach the running module (see PayloadModule.cfg).
      // Without a config, each module gets a private copy of its defaults.
      const defaults = DEFAULT_CONFIG.modules!
      const modules: ModulesConfig = config
        ? (config.modules ??= structuredClone(defaults))
        : structuredClone(defaults)
      const slots = modules as unknown as Record<BuiltinKey, ModuleSwitchConfig | undefined>
      for (const { key, create } of BUILTINS) {
        const cfg = (slots[key] ??= structuredClone(defaults[key]) ?? { enabled: false })
        this.register(create(cfg))
      }
    }
  }

  /**
   * A response an enabled module serves in place of the provider's, or
   * undefined to forward. The first module that answers wins; one that
   * throws is logged and skipped, so the request is forwarded as usual.
   */
  respond(requestBody: string, ctx: GatewayModuleContext): ModuleResponse | undefined {
    for (const mod of this.modules.values()) {
      if (!mod.enabled || !mod.respond) continue
      try {
        const answer = mod.respond(requestBody, ctx)
        if (answer) return answer
      } catch (err) {
        log.error('module failed to answer a request; forwarding it', { module: mod.id, err })
      }
    }
    return undefined
  }

  /** True when an enabled module wants to see responses, so callers capture them. */
  wantsResponses(): boolean {
    for (const mod of this.modules.values()) {
      if (mod.enabled && mod.observeResponse) return true
    }
    return false
  }

  // Fails open like transformRequest: a module that throws is logged and the
  // others still see the response.
  observeResponse(requestBody: string, ctx: GatewayModuleContext, response: CapturedResponse): void {
    for (const mod of this.modules.values()) {
      if (!mod.enabled || !mod.observeResponse) continue
      try {
        mod.observeResponse(requestBody, ctx, response)
      } catch (err) {
        log.error('module failed on a response; ignored', { module: mod.id, err })
      }
    }
  }

  register(module: GatewayModule): void {
    this.modules.set(module.id, module)
  }

  getModule(id: string): GatewayModule | undefined {
    return this.modules.get(id)
  }

  listModules(): GatewayModule[] {
    return Array.from(this.modules.values())
  }

  /** Returns false when no module with that id is registered. */
  setModuleEnabled(id: string, enabled: boolean): boolean {
    const mod = this.modules.get(id)
    if (!mod) return false
    mod.enabled = enabled
    return true
  }

  // Fails open, like the judge: a module that throws or rejects is logged and
  // skipped, and the request continues with the body as the previous module
  // left it. A transformation is an optimisation, never a reason to drop a
  // request.
  //
  // Consecutive built-in payload modules share one parsed payload and one
  // serialisation (see PayloadModule.transformParsed). One of them that
  // throws may leave the slots it already rewrote rewritten: each rewrite is
  // a whole, valid replacement of one text field, so the body stays valid.
  async transformRequest(
    body: string,
    ctx: GatewayModuleContext
  ): Promise<{ body: string; modified: boolean; events: ModuleEvent[] }> {
    let currentBody = body
    let anyModified = false
    const allEvents: ModuleEvent[] = []
    // undefined: not parsed since the body last changed as a string; null:
    // not a JSON object, which payload modules pass through unchanged.
    let parsed: Record<string, unknown> | null | undefined
    let dirty = false
    const estimates = new Map<string, number>()
    const flush = (): void => {
      if (dirty && parsed) currentBody = JSON.stringify(parsed)
      dirty = false
    }

    for (const mod of this.modules.values()) {
      if (!mod.enabled) continue

      let result: { modified: boolean; body?: string; events?: ModuleEvent[] | undefined }
      try {
        if (mod instanceof PayloadModule) {
          if (parsed === undefined) parsed = parsePayload(currentBody)
          if (parsed === null) continue
          if (mod.prepare) await mod.prepare(parsed, ctx)
          result = mod.transformParsed(parsed, ctx, estimates)
          if (result.modified) dirty = true
        } else {
          flush()
          result = await mod.transformRequest(currentBody, ctx)
          if (result.modified && result.body !== undefined) {
            currentBody = result.body
            parsed = undefined
          }
        }
      } catch (err) {
        log.error('module failed; request continues without it', { module: mod.id, err })
        continue
      }
      if (result.modified) anyModified = true
      if (result.events && result.events.length > 0) {
        allEvents.push(...result.events)
      }
    }
    flush()

    return {
      body: currentBody,
      modified: anyModified,
      events: allEvents,
    }
  }

  getSummaryStats(): ModulesSummaryStats {
    let totalTokensOriginal = 0
    let totalTokensPruned = 0
    let totalTokensSaved = 0
    let latest: ModuleEvent | undefined

    for (const mod of this.modules.values()) {
      const stats: ModuleStats = mod.getStats()
      totalTokensOriginal += stats.tokensOriginal
      totalTokensPruned += stats.tokensPruned
      totalTokensSaved += stats.tokensSaved
      // recentEvents is newest first
      const newest = stats.recentEvents[0]
      if (newest && (!latest || newest.timestamp > latest.timestamp)) latest = newest
    }

    const overallPercentSaved = totalTokensOriginal > 0
      ? Math.round(((totalTokensSaved / totalTokensOriginal) * 100) * 10) / 10
      : 0

    return {
      totalTokensOriginal,
      totalTokensPruned,
      totalTokensSaved,
      overallPercentSaved,
      ...(latest?.applied === undefined ? {} : { applied: latest.applied }),
    }
  }
}
