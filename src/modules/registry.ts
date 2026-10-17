import type { GatewayModule, GatewayModuleContext, ModuleStats } from './types.js'
import type { ModuleEvent, Config, ModulesConfig, ModuleSwitchConfig, RepeatCollapseConfig, ToolResultPrunerConfig } from '../types.js'
import type { CapturedResponse } from './responseTap.js'
import { AnsiStripModule } from './builtin/ansiStrip.js'
import { ProgressCollapseModule } from './builtin/progressCollapse.js'
import { RepeatCollapseModule } from './builtin/repeatCollapse.js'
import { TokenPrunerModule } from './builtin/tokenPruner.js'
import { ToolResultPrunerModule } from './builtin/toolResultPruner.js'
import { ToolDefinitionPrunerModule } from './builtin/toolDefinitionPruner.js'
import { UsageMeterModule } from './builtin/usageMeter.js'
import { DEFAULT_CONFIG } from '../config/config.js'
import { createLogger } from '../logger.js'

const log = createLogger('modules')

type BuiltinKey = Exclude<keyof ModulesConfig, 'enabled'>

// Built-in modules in pipeline order, each keyed by the `modules.<key>`
// object that holds its switch and options. Content cleaners run first, so
// the whitespace pruners see text without escape codes.
export const BUILTINS: Array<{ key: BuiltinKey; create: (cfg: ModuleSwitchConfig) => GatewayModule }> = [
  { key: 'ansiStrip', create: cfg => new AnsiStripModule(cfg) },
  { key: 'progressCollapse', create: cfg => new ProgressCollapseModule(cfg) },
  { key: 'repeatCollapse', create: cfg => new RepeatCollapseModule(cfg as RepeatCollapseConfig) },
  { key: 'tokenPruner', create: cfg => new TokenPrunerModule(cfg) },
  { key: 'toolResultPruner', create: cfg => new ToolResultPrunerModule(cfg as ToolResultPrunerConfig) },
  { key: 'toolDefinitionPruner', create: cfg => new ToolDefinitionPrunerModule(cfg) },
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
  async transformRequest(
    body: string,
    ctx: GatewayModuleContext
  ): Promise<{ body: string; modified: boolean; events: ModuleEvent[] }> {
    let currentBody = body
    let anyModified = false
    const allEvents: ModuleEvent[] = []

    for (const mod of this.modules.values()) {
      if (!mod.enabled) continue

      let result
      try {
        result = await mod.transformRequest(currentBody, ctx)
      } catch (err) {
        log.error('module failed; request continues without it', { module: mod.id, err })
        continue
      }
      if (result.modified) {
        currentBody = result.body
        anyModified = true
      }
      if (result.events && result.events.length > 0) {
        allEvents.push(...result.events)
      }
    }

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
